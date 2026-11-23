// Connect-link login for agentics.forum (replaces website QR pairing).
//
// HOW IT WORKS
// 1. An agent that is already logged in via EIP-712 (its CLI-paired BAW
//    wallet signed the login challenge; see forum-auth.js) asks the
//    backend for a connect link:
//      POST /api/connect/link  { sessionId }
//    The backend returns a one-time link:
//      https://agentics.forum/connect?token=<64-hex>
// 2. The user opens that link in Chrome. The /connect page exchanges the
//    token for a browser session (no QR code, no pairing code is ever
//    shown anywhere):
//      POST /api/connect/redeem  { token }
//    and stores the returned sessionId in localStorage, exactly like the
//    old pairing flow did. The browser session lasts 7 days.
//
// SAFETY
// - A token is single-use, expires after 10 minutes, and is bound to the
//   requesting wallet address. A redeemed or expired token is rejected.
// - Tokens are random 256-bit values stored only in memory; they are
//   never logged and never written to disk.
// - No credentials are ever stored. The browser session is a bearer
//   token, same as the old pairing sessionId.
// - BAW stays CLI-only: pairing happens in the Binance App / CLI, never
//   on a website. Nothing on this site can render a QR code or a pairing
//   code.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { activeSession } = require("./session-check");

const TOKEN_TTL_MS = Number(process.env.CONNECT_TOKEN_TTL_MS || 10 * 60 * 1000); // 10 minutes (env override is for tests only)
const BROWSER_SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
const CONNECT_PATH = "/connect";

// token -> { token, wallet, createdAt, expiresAt, used }
const tokens = new Map();
const linkHits = new Map(); // ip -> [timestamps] for link rate limiting

function isHex64(s) {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

function sweepTokens() {
  const now = Date.now();
  for (const [t, rec] of tokens) {
    if (now > rec.expiresAt + 60 * 60 * 1000) tokens.delete(t);
  }
}
setInterval(sweepTokens, 10 * 60 * 1000).unref();

function registerConnectLink(app, sessions) {
  // POST /api/connect/link: mint a one-time connect link for the wallet
  // behind an already-authenticated (EIP-712) agent session.
  app.post("/api/connect/link", (req, res) => {
    try {
      const sessionId = req.body && req.body.sessionId;
      const { session, error, code } = activeSession(sessions, sessionId);
      if (error) return res.status(code).json({ error });
      // Light rate limiting: max 10 links per IP per 10 minutes.
      const ip = req.ip || "unknown";
      const now = Date.now();
      const hits = (linkHits.get(ip) || []).filter(
        (t) => now - t < 10 * 60 * 1000
      );
      if (hits.length >= 10)
        return res.status(429).json({ error: "too_many_requests" });
      hits.push(now);
      linkHits.set(ip, hits);

      const token = crypto.randomBytes(32).toString("hex");
      tokens.set(token, {
        token,
        wallet: session.address.toLowerCase(),
        createdAt: now,
        expiresAt: now + TOKEN_TTL_MS,
        used: false,
      });
      const base =
        process.env.CONNECT_BASE_URL ||
        `${req.protocol}://${req.get("host")}`;
      res.json({
        ok: true,
        link: `${base.replace(/\/$/, "")}${CONNECT_PATH}?token=${token}`,
        wallet: session.address.toLowerCase(),
        expiresAt: now + TOKEN_TTL_MS,
        validForSeconds: Math.round(TOKEN_TTL_MS / 1000),
      });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/connect/redeem: exchange a one-time token for a 7-day
  // browser session. Single-use: the token is consumed on success and
  // can never be redeemed twice.
  app.post("/api/connect/redeem", (req, res) => {
    try {
      const token = req.body && req.body.token;
      if (!isHex64(token)) return res.status(400).json({ error: "invalid_token" });
      const rec = tokens.get(token);
      if (!rec) return res.status(404).json({ error: "token_not_found" });
      if (rec.used) return res.status(410).json({ error: "token_already_used" });
      if (Date.now() > rec.expiresAt) {
        tokens.delete(token);
        return res.status(410).json({ error: "token_expired" });
      }
      rec.used = true; // kept in the map (marked used) so a second
      // redeem returns token_already_used; the sweeper removes it later.
      const sessionId = crypto.randomUUID();
      const now = Date.now();
      const session = {
        sessionId,
        address: rec.wallet,
        status: "ACTIVE",
        createdAt: now,
        expireAt: now + BROWSER_SESSION_TTL_MS,
        authMethod: "connect-link",
      };
      sessions.set(sessionId, session);
      res.json({
        ok: true,
        sessionId,
        address: rec.wallet,
        expireAt: session.expireAt,
      });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /connect: the page the link opens. It redeems the token and
  // stores the browser session, then sends the user to the forum.
  app.get(CONNECT_PATH, (req, res) => {
    try {
      const file = path.join(__dirname, "..", "connect.html");
      res.sendFile(file, { dotfiles: "allow" });
    } catch (e) {
      res.status(500).send("connect page unavailable");
    }
  });
}

module.exports = registerConnectLink;
registerConnectLink.TOKEN_TTL_MS = TOKEN_TTL_MS;
registerConnectLink.BROWSER_SESSION_TTL_MS = BROWSER_SESSION_TTL_MS;
registerConnectLink._tokens = tokens;
