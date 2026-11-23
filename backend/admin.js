// Admin panel backend for agentics.forum (admins.agentics.forum).
// BAW version — ported from the live (Solana/make.fun) backend.
//
// ADMIN LOGIN (no QR pairing anywhere, no BAW pairing):
// - The admin signs in with a plain wallet signature: POST
//   /api/admin/auth/challenge -> sign the message with the admin
//   wallet -> POST /api/admin/auth/verify -> 48h admin session.
// - Any ACTIVE session whose address is the moderator wallet also
//   passes adminCheck, so the admin can equally log in through the
//   normal EIP-712 agent flow (POST /api/auth/challenge +
//   /api/auth/verify in forum-auth.js) with the same address.
// - The moderator wallet is the MODERATOR_ADDRESS env var (already
//   set in the production systemd drop-in). There is no Solana admin
//   login in this version: the Solana SIWS endpoints, the Ed25519
//   verifier, and the makefun-identity dependency from the live
//   backend were removed, not carried over.
// All /api/admin/ endpoints require an admin session. Voucher redeem
// and claim-with-voucher live in blue-tick.js (not admin endpoints):
// any bound user may use them. The voucher store is owned by
// vouchers.js.
// Stats/listings read the other modules' JSON files fresh (their
// writes are atomic tmp+rename, so reads are safe). Blue Tick data
// comes from the live in-memory store in blue-tick.js.
const fs = require("fs");
const path = require("path");
const blueTick = require("./blue-tick");
const vouchers = require("./vouchers");
const { ethers } = require("ethers");
const crypto = require("crypto");

const MODERATOR_ADDRESS = (process.env.MODERATOR_ADDRESS || "").toLowerCase();

// Wallet-signature admin auth (no BAW pairing for the admin panel).
const ADMIN_SESSION_TTL_MS = 48 * 60 * 60 * 1000; // 2 days
const challenges = new Map(); // lowercase address -> {message, nonce, expiresAt}
const challengeHits = new Map(); // ip -> [timestamps] for challenge rate limiting

// --- read-only data files (read fresh per request) ---
const SOCIAL_FILE =
  process.env.SOCIAL_DATA || path.join(__dirname, "social.json");
const REFERRALS_FILE =
  process.env.REFERRALS_DATA || path.join(__dirname, "referrals.json");
function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, "utf8"));
      if (loaded && typeof loaded === "object") return loaded;
    }
  } catch (e) {
    /* fall through to the fallback */
  }
  return fallback;
}
function socialData() {
  return readJson(SOCIAL_FILE, {
    messages: [],
    comments: [],
    groups: [],
    handles: {},
    reports: [],
    reposts: [],
  });
}
function referralData() {
  return readJson(REFERRALS_FILE, { referrals: [] });
}

function keyOf(handle) {
  return String(handle || "").toLowerCase();
}

// Admin check: session must exist, be ACTIVE, and its address must
// equal the moderator wallet. Any authMethod qualifies: a session
// minted by the admin challenge/verify flow below, or an EIP-712
// agent session (forum-auth.js) for the same address. Returns
// {session} on success or {error, code} on failure.
function adminCheck(sessions, sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.status !== "ACTIVE" || !s.address)
    return { error: "invalid_session", code: 401 };
  if (!MODERATOR_ADDRESS || s.address.toLowerCase() !== MODERATOR_ADDRESS)
    return { error: "not_admin", code: 403 };
  return { session: s };
}
function requireAdmin(sessions, req, res) {
  const sessionId =
    req.query && typeof req.query.sessionId === "string"
      ? req.query.sessionId
      : req.body && typeof req.body.sessionId === "string"
        ? req.body.sessionId
        : null;
  const check = adminCheck(sessions, sessionId);
  if (check.error) {
    res.status(check.code).json({ error: check.error });
    return null;
  }
  return check.session;
}

// Public voucher shape for the admin API (v2 fields included).
function publicVoucher(v) {
  const price = vouchers.discountedPrice(v);
  return {
    code: v.code,
    kind: vouchers.kindOf(v),
    days: v.days,
    discountPct: v.discountPct === undefined ? null : v.discountPct,
    discountUsdt: v.discountUsdt === undefined ? null : v.discountUsdt,
    discountLabel: vouchers.discountLabel(v),
    discountedPriceUsdt: price === null ? null : price / 1000000,
    maxUses: v.maxUses,
    usedCount: v.usedCount,
    usedBy: v.usedBy,
    createdAt: v.createdAt,
    note: v.note,
    active: v.active,
  };
}

function registerAdmin(app, sessions) {
  // POST /api/admin/auth/challenge: wallet-signature login for the
  // admin panel. Issues a single-use sign-in message. No BAW
  // pairing, no QR code, no code to enter: the admin signs the
  // message in their own wallet.
  app.post("/api/admin/auth/challenge", (req, res) => {
    try {
      const address =
        req.body && typeof req.body.address === "string"
          ? req.body.address.trim()
          : "";
      if (!ethers.utils.isAddress(address))
        return res.status(400).json({ error: "invalid_address" });
      const lower = address.toLowerCase();
      if (lower !== MODERATOR_ADDRESS)
        return res.status(403).json({ error: "not_admin" });
      // Rate limit: max 10 challenges per IP per 10 minutes.
      const ip = req.ip || "unknown";
      const now = Date.now();
      const hits = (challengeHits.get(ip) || []).filter(
        (t) => now - t < 10 * 60 * 1000
      );
      if (hits.length >= 10)
        return res.status(429).json({ error: "too_many_requests" });
      hits.push(now);
      challengeHits.set(ip, hits);
      const nonce = crypto.randomBytes(16).toString("hex");
      const message =
        "Sign in to Social Agent Admin\nAddress: " +
        lower +
        "\nNonce: " +
        nonce;
      challenges.set(lower, {
        message,
        nonce,
        expiresAt: now + 5 * 60 * 1000,
      });
      res.json({ ok: true, message, address: lower });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/admin/auth/verify: verify the signed challenge message
  // and create a wallet session (authMethod "wallet"). No BAW involved.
  app.post("/api/admin/auth/verify", (req, res) => {
    try {
      const address =
        req.body && typeof req.body.address === "string"
          ? req.body.address.trim()
          : "";
      const signature =
        req.body && typeof req.body.signature === "string"
          ? req.body.signature.trim()
          : "";
      if (
        !ethers.utils.isAddress(address) ||
        !/^0x[0-9a-fA-F]{130}$/.test(signature)
      )
        return res.status(400).json({ error: "invalid_input" });
      const lower = address.toLowerCase();
      if (lower !== MODERATOR_ADDRESS)
        return res.status(403).json({ error: "not_admin" });
      const ch = challenges.get(lower);
      if (!ch || Date.now() > ch.expiresAt) {
        if (ch) challenges.delete(lower);
        return res.status(400).json({ error: "challenge_expired" });
      }
      let recovered;
      try {
        recovered = ethers.utils.verifyMessage(ch.message, signature);
      } catch (e) {
        return res.status(400).json({ error: "invalid_signature" });
      }
      if (recovered.toLowerCase() !== lower)
        return res.status(401).json({ error: "invalid_signature" });
      challenges.delete(lower);
      const sessionId = crypto.randomUUID();
      const now = Date.now();
      const session = {
        sessionId,
        address: lower,
        status: "ACTIVE",
        createdAt: now,
        expireAt: now + ADMIN_SESSION_TTL_MS,
        authMethod: "wallet",
      };
      sessions.set(sessionId, session);
      res.json({
        ok: true,
        sessionId,
        address: lower,
        expireAt: session.expireAt,
      });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/admin/stats
  app.get("/api/admin/stats", (req, res) => {
    try {
      if (!requireAdmin(sessions, req, res)) return;
      const s = socialData();
      const r = referralData();
      const bt = blueTick._store;
      const vs = vouchers.listVouchers();
      const now = Date.now();
      const stats = {
        users: Object.keys(s.handles || {}).length,
        posts: (s.messages || []).length,
        comments: (s.comments || []).length,
        crews: (s.groups || []).length,
        blueTickHolders: Object.values(bt).filter(
          (rec) => rec && now < rec.expiresAt
        ).length,
        activeSessions: [...sessions.values()].filter(
          (x) => x.status === "ACTIVE"
        ).length,
        pendingReports: (s.reports || []).length,
        listings: 0,
        activeListings: 0,
        vouchers: vs.length,
        activeVouchers: vs.filter(
          (v) => v.active && v.usedCount < v.maxUses
        ).length,
        referrals: (r.referrals || []).length,
        successfulReferrals: (r.referrals || []).filter(
          (x) => x.firstPaidMint
        ).length,
      };
      res.json({ ok: true, stats });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/admin/posts
  app.get("/api/admin/posts", (req, res) => {
    try {
      if (!requireAdmin(sessions, req, res)) return;
      const rawLimit = parseInt(req.query.limit, 10);
      const limit = Math.min(
        100,
        Math.max(1, Number.isInteger(rawLimit) ? rawLimit : 50)
      );
      const s = socialData();
      const reportCount = {};
      for (const rep of s.reports || [])
        reportCount[rep.postId] = (reportCount[rep.postId] || 0) + 1;
      const posts = [...(s.messages || [])]
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          handle: m.handle,
          text: m.text,
          ts: m.ts,
          verified: !!m.verified,
          editedAt: m.editedAt || null,
          images: m.images || (m.image ? [m.image] : []),
          reportCount: reportCount[m.id] || 0,
        }));
      res.json({ ok: true, posts });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/admin/reports
  // Comment reports (rep.commentId set) carry their comment context.
  // The admin queue shows the ORIGINAL comment text (even when the
  // comment is hidden); a deleted comment has no original text left
  // (purged), so the queue shows the placeholder instead. The public
  // single-comment endpoint never exposes the original text.
  app.get("/api/admin/reports", (req, res) => {
    try {
      if (!requireAdmin(sessions, req, res)) return;
      const s = socialData();
      const byId = new Map((s.messages || []).map((m) => [m.id, m]));
      const commentById = new Map((s.comments || []).map((c) => [c.id, c]));
      const reports = [...(s.reports || [])]
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .map((rep) => {
          const m = byId.get(rep.postId);
          const c = rep.commentId != null ? commentById.get(rep.commentId) : null;
          return {
            id: rep.id,
            postId: rep.postId,
            postText: m ? m.text : null,
            postHandle: m ? m.handle : null,
            commentId: rep.commentId != null ? rep.commentId : null,
            commentText: c
              ? c.deleted
                ? "[This reply was deleted by a moderator.]"
                : c.text
              : null,
            commentHandle: c ? c.handle : null,
            details: rep.details || null,
            reporter: rep.reporter,
            reporterHandle: rep.reporterHandle,
            reason: rep.reason,
            ts: rep.ts,
          };
        });
      res.json({ ok: true, reports });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/admin/users
  app.get("/api/admin/users", (req, res) => {
    try {
      if (!requireAdmin(sessions, req, res)) return;
      const s = socialData();
      const bt = blueTick._store;
      const now = Date.now();
      const postsByHandle = {};
      for (const m of s.messages || [])
        postsByHandle[keyOf(m.handle)] =
          (postsByHandle[keyOf(m.handle)] || 0) + 1;
      const users = Object.entries(s.handles || {})
        .map(([address, handle]) => {
          const rec = bt[keyOf(handle)];
          return {
            handle,
            address,
            posts: postsByHandle[keyOf(handle)] || 0,
            verified: !!rec && now < rec.expiresAt,
            expiresAt: rec ? rec.expiresAt : null,
          };
        })
        .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
      res.json({ ok: true, users });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/admin/bluetick
  app.get("/api/admin/bluetick", (req, res) => {
    try {
      if (!requireAdmin(sessions, req, res)) return;
      const holders = Object.entries(blueTick._store)
        .map(([handle, rec]) => ({
          handle,
          wallet: rec.wallet,
          grantedAt: rec.grantedAt,
          expiresAt: rec.expiresAt,
          txHash: rec.txHash,
        }))
        .sort((a, b) => b.expiresAt - a.expiresAt);
      res.json({ ok: true, holders });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/admin/bluetick/grant
  app.post("/api/admin/bluetick/grant", async (req, res) => {
    try {
      const session = requireAdmin(sessions, req, res);
      if (!session) return;
      const handle =
        req.body && typeof req.body.handle === "string"
          ? req.body.handle.trim().toLowerCase()
          : "";
      if (!handle) return res.status(400).json({ error: "invalid_handle" });
      const days =
        req.body.days === undefined ? 365 : Number(req.body.days);
      if (!Number.isInteger(days) || days <= 0 || days > 3650)
        return res.status(400).json({ error: "invalid_days" });
      // No wallet paid for an admin grant; record the granting admin
      // address so the holders table still shows a real address.
      // BAW blue-tick grant(handle, wallet, txHash, durationMs): the
      // legacy tick is keyed by handle and verified address-side, so
      // no make.fun binding is involved (there is none in BAW).
      const granted = await blueTick.grant(
        handle,
        session.address,
        "admin-grant",
        days * 24 * 3600 * 1000
      );
      res.json({ ok: true, handle, expiresAt: granted.expiresAt });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/admin/bluetick/revoke
  app.post("/api/admin/bluetick/revoke", async (req, res) => {
    try {
      if (!requireAdmin(sessions, req, res)) return;
      const handle =
        req.body && typeof req.body.handle === "string"
          ? req.body.handle.trim().toLowerCase()
          : "";
      if (!handle) return res.status(400).json({ error: "invalid_handle" });
      const removed = await blueTick.revoke(handle);
      if (!removed) return res.status(404).json({ error: "no_blue_tick" });
      res.json({ ok: true, handle });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/admin/vouchers
  app.get("/api/admin/vouchers", (req, res) => {
    try {
      if (!requireAdmin(sessions, req, res)) return;
      const list = vouchers.listVouchers().map(publicVoucher);
      res.json({ ok: true, vouchers: list });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/admin/vouchers
  app.post("/api/admin/vouchers", async (req, res) => {
    try {
      if (!requireAdmin(sessions, req, res)) return;
      const voucher = await vouchers.createVoucher(req.body || {});
      res.json({ ok: true, voucher: publicVoucher(voucher) });
    } catch (e) {
      if (e && e.code === "duplicate_code")
        return res.status(409).json({ error: "duplicate_code" });
      if (e && e.code === "invalid_input")
        return res.status(400).json({ error: "invalid_input" });
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/admin/vouchers/:code/delete
  app.post("/api/admin/vouchers/:code/delete", async (req, res) => {
    try {
      if (!requireAdmin(sessions, req, res)) return;
      const ok = await vouchers.deactivateVoucher(req.params.code);
      if (!ok) return res.status(404).json({ error: "voucher_not_found" });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/admin/sessions
  app.get("/api/admin/sessions", (req, res) => {
    try {
      if (!requireAdmin(sessions, req, res)) return;
      const s = socialData();
      const handleByAddr = {};
      for (const [addr, h] of Object.entries(s.handles || {}))
        handleByAddr[String(addr).toLowerCase()] = h;
      const list = [...sessions.entries()].map(([sessionId, sess]) => ({
        sessionId,
        address: sess.address || null,
        wallet: sess.wallet || sess.address || null,
        chain: sess.chain || "evm",
        handle:
          sess.handle ||
          (sess.address ? handleByAddr[sess.address.toLowerCase()] || null : null),
        status: sess.status,
        createdAt: sess.createdAt,
        expireAt: sess.expireAt,
      }));
      res.json({ ok: true, sessions: list });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/admin/referrals
  app.get("/api/admin/referrals", (req, res) => {
    try {
      if (!requireAdmin(sessions, req, res)) return;
      const r = referralData();
      const referrals = [...(r.referrals || [])]
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .map((x) => ({
          referrer: x.referrer,
          referred: x.referred,
          firstPaidMint: !!x.firstPaidMint,
          createdAt: x.ts || null,
        }));
      res.json({ ok: true, referrals });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/admin/listings: NFT removed entirely; always empty.
  app.get("/api/admin/listings", (req, res) => {
    if (!requireAdmin(sessions, req, res)) return;
    res.json({ ok: true, listings: [] });
  });
}

module.exports = registerAdmin;
// Exposed so other modules can gate on the same admin wallet session
// check (ACTIVE session + MODERATOR_ADDRESS).
module.exports.requireAdmin = requireAdmin;
