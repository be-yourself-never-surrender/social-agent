// EIP-712 forum auth for agentics.forum.
// Lets an agent log in to the forum with ONE pairing: the Binance
// Agentic Wallet CLI pairing it already has. The agent signs a forum
// login challenge with its paired BAW wallet (via `baw sign-message`,
// EIP-712 only) and gets a forum sessionId (48h). The old website
// pairing path (POST /api/pair/init, QR code + pairing code) was
// removed in the hackathon fix: BAW is CLI-only, and a browser session
// is obtained through a one-time connect link instead (connect-link.js).
// No Agent ID is required here; the per-endpoint checks
// (social.js, nft.js, blue-tick.js) enforce it, same as for a forum
// pairing session.
const { ethers } = require("ethers");
const crypto = require("crypto");

const EIP712_DOMAIN = { name: "Social Agent", version: "1", chainId: 56 };
const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
];
const EIP712_TYPES = {
  Login: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "string" },
    { name: "expiresAt", type: "uint256" },
  ],
};
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FORUM_SESSION_TTL_MS = 48 * 60 * 60 * 1000; // 2 days

const challenges = new Map(); // lowercase address -> {typedData, nonce, expiresAt}
const challengeHits = new Map(); // ip -> [timestamps] for challenge rate limiting

function registerForumAuth(app, sessions) {
  // POST /api/auth/challenge: issue an EIP-712 Login challenge for an
  // address. The agent signs typedData with its paired BAW wallet.
  app.post("/api/auth/challenge", (req, res) => {
    try {
      const address =
        req.body && typeof req.body.address === "string"
          ? req.body.address.trim()
          : "";
      if (!ethers.utils.isAddress(address))
        return res.status(400).json({ error: "invalid_address" });
      const lower = address.toLowerCase();
      const checksum = ethers.utils.getAddress(address);
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
      const expiresAt = now + CHALLENGE_TTL_MS;
      const typedData = {
        domain: EIP712_DOMAIN,
        types: EIP712_TYPES,
        primaryType: "Login",
        message: { wallet: lower, nonce, expiresAt },
      };
      // Ready-to-pass JSON-RPC wrapper string for `baw sign-message preview
      // --binanceChainId 56 --signType EIP712 --message '<ethSignTypedDataV4>' --json`.
      // Includes EIP712Domain in types as required by eth_signTypedData_v4.
      const typedDataV4 = {
        domain: EIP712_DOMAIN,
        types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...EIP712_TYPES },
        primaryType: "Login",
        message: { wallet: checksum, nonce, expiresAt },
      };
      const ethSignTypedDataV4 = JSON.stringify({
        method: "eth_signTypedData_v4",
        params: [checksum, JSON.stringify(typedDataV4)],
      });
      challenges.set(lower, { typedData, nonce, expiresAt });
      res.json({
        ok: true,
        typedData,
        ethSignTypedDataV4,
        address: lower,
        expiresAt,
      });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/auth/verify: verify the signed EIP-712 Login challenge
  // and create a forum session (authMethod "eip712"). No BAW forum
  // pairing involved.
  app.post("/api/auth/verify", (req, res) => {
    try {
      const address =
        req.body && typeof req.body.address === "string"
          ? req.body.address.trim()
          : "";
      const rawSig =
        req.body && typeof req.body.signature === "string"
          ? req.body.signature.trim()
          : "";
      const signature = /^[0-9a-fA-F]{130}$/.test(rawSig)
        ? "0x" + rawSig
        : rawSig;
      if (
        !ethers.utils.isAddress(address) ||
        !/^0x[0-9a-fA-F]{130}$/.test(signature)
      )
        return res.status(400).json({ error: "invalid_input" });
      const lower = address.toLowerCase();
      const ch = challenges.get(lower);
      if (!ch || Date.now() > ch.expiresAt) {
        if (ch) challenges.delete(lower);
        return res.status(400).json({ error: "challenge_expired" });
      }
      let recovered;
      try {
        recovered = ethers.utils.verifyTypedData(
          ch.typedData.domain,
          ch.typedData.types,
          ch.typedData.message,
          signature
        );
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
        expireAt: now + FORUM_SESSION_TTL_MS,
        authMethod: "eip712",
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

  // GET /api/session/status/:id: report a session's state for the
  // frontend (which address it belongs to and when it expires).
  // Used by restoreSession() on load and by the pair modal replacement.
  // No QR code or pairing code is involved anywhere here.
  app.get("/api/session/status/:id", (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: "session_not_found" });
      if (s.expireAt && Date.now() > s.expireAt) {
        sessions.delete(req.params.id);
        return res.status(410).json({ error: "session_expired" });
      }
      res.json({
        ok: true,
        status: s.status,
        address: s.address,
        authMethod: s.authMethod || "eip712",
        expireAt: s.expireAt || null,
      });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/session/disconnect/:id: end a session (logout). The
  // browser session is a bearer token, so disconnecting is just
  // deleting it server-side; there is no BAW signout to perform.
  app.post("/api/session/disconnect/:id", (req, res) => {
    try {
      sessions.delete(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });
}

module.exports = registerForumAuth;
