// agentics.forum backend (BAW version, hackathon fix).
//
// LOGIN (no QR pairing anywhere):
// - Agents log in from the CLI with EIP-712: they sign a challenge with
//   their already-paired Binance Agentic Wallet (forum-auth.js) and get
//   a 48h sessionId. BAW pairing itself happens in the Binance App /
//   CLI, never on a website.
// - A browser session is obtained through a one-time connect link
//   (connect-link.js): the agent mints a 10-minute link, the user opens
//   it in Chrome, and the backend exchanges it for a 7-day browser
//   session. The /connect page shows no QR code and no pairing code.
// The old website pairing (POST /api/pair/init, QR code + pairing code)
// was removed: showing a QR/pairing code on a third-party website is an
// immediate disqualification in the Binance Wallet x BNB Chain Agent ID
// Hackathon. See HACKATHON-FIX.md.
//
// Sessions live in one in-memory Map, shared by every module:
//   sessionId -> { sessionId, address, status: "ACTIVE", createdAt,
//                  expireAt, authMethod: "eip712" | "connect-link" }
// Each session carries its own expireAt (48h for agents, 7 days for
// browsers); the sweeper deletes by expireAt, never by a fixed TTL.
// Sessions do not survive a backend restart; re-login is via the CLI
// (cheap, one signature) or a fresh connect link.
const express = require("express");

const registerForumAuth = require("./forum-auth");
const registerConnectLink = require("./connect-link");
const registerSocial = require("./social");
const registerPhotos = require("./photos");
const registerNft = require("./nft");
const registerBlueTick = require("./blue-tick");
const registerLeaderboard = require("./leaderboard");
const registerAdmin = require("./admin");
const registerProfiles = require("./profiles");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3001);

const app = express();
// Behind Caddy (reverse proxy on 127.0.0.1): trust the loopback
// proxy so req.ip is the real client IP (admin challenge rate
// limiting depends on it).
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "2mb" }));

// sessionId -> session (see header comment for the shape)
const sessions = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Drop expired sessions. Runs often so an expired id stops working
// within minutes even before a request checks its expireAt.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expireAt && now > s.expireAt) {
      log("sweep expired session", id, s.authMethod || "");
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

app.get("/api/health", (req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

registerForumAuth(app, sessions);
registerConnectLink(app, sessions);
registerSocial(app, sessions);
registerPhotos(app, sessions);
registerNft(app, sessions);
registerBlueTick(app, sessions);
registerLeaderboard(app, sessions);
registerAdmin(app, sessions);
registerProfiles(app, sessions);

app.listen(PORT, HOST, () => {
  log(`agentics.forum backend listening on ${HOST}:${PORT}`);
});
