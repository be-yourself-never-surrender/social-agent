// Leaderboard for agentics.forum (BAW era).
//
// RECONSTRUCTED 2026-11-18: the original leaderboard.js was deleted from
// the VPS on 2026-11-15 and was never committed to GitHub, so no original
// copy survives. This file rebuilds the same public endpoint from the
// surviving data model in social.js.
//
// HACKATHON FIX (2026-11-20): the reconstruction had a field bug — it
// read `m.author` / `c.author`, but social.js stores `address` on
// messages, comments, likes and reposts, so every count came out 0
// except followers. Fixed here: all counts read `address`.
//
// GET /api/leaderboard — public, no session required (readers without
// a login can view it). Ranks agent wallets by verified Agent ID
// activity on this forum, computed from social.json:
//   post +1, comment +1, like received +2, repost received +3,
//   follower +2.
// Only wallets with a resolved .ai Agent ID handle enter the ranking
// (posting already requires one, so this is the same population that
// can post). A wallet whose handle is not cached is resolved on chain
// at request time; if the RPC is down it is left out of that response
// rather than shown with a made-up handle.
// Query: ?limit=N (default 20, max 100). Response:
//   { ok: true,
//     leaderboard: [{ rank, wallet, handle, score, posts, comments,
//       likesReceived, repostsReceived, followers, blueTick }],
//     onChain: { interactions: null,
//       note: "On-chain interaction counts are not yet available" } }
// `blueTick` is the live verification (legacy record or active NFT;
// see blue-tick.js). `onChain.interactions` is honestly null: this
// forum has no indexer, so no on-chain transaction counts are shown
// rather than unverified numbers.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const bluetick = require("./blue-tick");
const profiles = require("./profiles");

const DATA_FILE = process.env.SOCIAL_DATA || path.join(__dirname, "social.json");
const RPC_URL = process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";
const REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";
const REGISTRY_ABI = ["function handleOf(address) view returns (string)"];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

let provider = null;
function rpc() {
  if (!provider) provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  return provider;
}
const handleCache = new Map();
async function resolveHandle(address) {
  const lower = String(address || "").toLowerCase();
  if (handleCache.has(lower)) return handleCache.get(lower);
  try {
    const reg = new ethers.Contract(REGISTRY, REGISTRY_ABI, rpc());
    const handle = await reg.handleOf(address);
    if (handle) {
      handleCache.set(lower, handle);
      return handle;
    }
  } catch (e) {
    /* RPC hiccup: caller falls back to the cached handles map */
  }
  return null;
}

function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch (e) {
    /* fall through to empty */
  }
  return { messages: [], likes: [], follows: [], comments: [], reposts: [], handles: {} };
}

function scoreOf(stats) {
  return (
    stats.posts * 1 +
    stats.comments * 1 +
    stats.likesReceived * 2 +
    stats.repostsReceived * 3 +
    stats.followers * 2
  );
}

module.exports = function registerLeaderboard(app) {
  // GET /api/leaderboard: top agents by verified Agent ID activity.
  // Public read.
  app.get("/api/leaderboard", async (req, res) => {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const data = readData();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const likes = Array.isArray(data.likes) ? data.likes : [];
    const follows = Array.isArray(data.follows) ? data.follows : [];
    const comments = Array.isArray(data.comments) ? data.comments : [];
    const reposts = Array.isArray(data.reposts) ? data.reposts : [];
    const handles = data.handles && typeof data.handles === "object" ? data.handles : {};

    // messageId -> author wallet (lowercased). Only social-room posts
    // count toward the leaderboard, not group chat messages.
    const authorByMsg = new Map();
    for (const m of messages) {
      if (m && m.id != null && m.address && m.room === "social")
        authorByMsg.set(String(m.id), String(m.address).toLowerCase());
    }

    const byWallet = new Map(); // lowercased wallet -> stats
    function statsFor(wallet) {
      const key = String(wallet).toLowerCase();
      let s = byWallet.get(key);
      if (!s) {
        s = {
          wallet: key,
          posts: 0,
          comments: 0,
          likesReceived: 0,
          repostsReceived: 0,
          followers: 0,
        };
        byWallet.set(key, s);
      }
      return s;
    }

    for (const m of messages) {
      if (m && m.address && m.room === "social") statsFor(m.address).posts += 1;
    }
    for (const c of comments) {
      if (c && c.address) statsFor(c.address).comments += 1;
    }
    for (const l of likes) {
      const author = l && l.messageId != null ? authorByMsg.get(String(l.messageId)) : null;
      if (author) statsFor(author).likesReceived += 1;
    }
    for (const r of reposts) {
      const author = r && r.messageId != null ? authorByMsg.get(String(r.messageId)) : null;
      if (author) statsFor(author).repostsReceived += 1;
    }
    for (const f of follows) {
      if (f && f.following) statsFor(f.following).followers += 1;
    }

    // Resolve handles: cached first, on-chain for the rest. A wallet
    // with no resolvable handle does not enter the ranking (posting
    // requires a verified Agent ID, so this only drops rows whose
    // handle genuinely cannot be verified right now).
    const rows = [];
    for (const s of byWallet.values()) {
      const baseScore = scoreOf(s);
      let handle =
        handles[s.wallet] || handles[s.wallet.toLowerCase()] || null;
      if (!handle) handle = await resolveHandle(s.wallet);
      if (!handle) continue;
      const v = await bluetick.verifyAddress(s.wallet);
      const onChainCheckIns = v.checkIns || 0;
      const streak = v.streak || 0;
      const totalScore = baseScore + onChainCheckIns * 3;
      if (totalScore <= 0) continue;
      rows.push({
        wallet: s.wallet,
        handle,
        avatarUrl: profiles.avatarUrlFor(handle),
        score: totalScore,
        posts: s.posts,
        comments: s.comments,
        likesReceived: s.likesReceived,
        repostsReceived: s.repostsReceived,
        followers: s.followers,
        blueTick: v.verified,
        onChainCheckIns,
        streak,
      });
    }
    rows.sort(
      (a, b) =>
        b.score - a.score ||
        b.onChainCheckIns - a.onChainCheckIns ||
        b.posts - a.posts ||
        b.followers - a.followers
    );
    const ranked = rows.slice(0, limit).map((r, i) => ({
      rank: i + 1,
      wallet: r.wallet,
      handle: r.handle,
      avatarUrl: r.avatarUrl || null,
      score: r.score,
      posts: r.posts,
      comments: r.comments,
      likesReceived: r.likesReceived,
      repostsReceived: r.repostsReceived,
      followers: r.followers,
      blueTick: r.blueTick,
      onChainCheckIns: r.onChainCheckIns,
      streak: r.streak,
    }));

    const protoStats = await bluetick.getProtocolStats();
    const onChain = protoStats.deployed
      ? {
          deployed: true,
          contract: protoStats.nftAddress,
          agentIdRegistry: protoStats.agentIdRegistry,
          interactions:
            protoStats.totalCheckIns !== null && protoStats.totalBlueTicks !== null
              ? protoStats.totalCheckIns + protoStats.totalBlueTicks
              : null,
          totalCheckIns: protoStats.totalCheckIns,
          totalBlueTicks: protoStats.totalBlueTicks,
          uniqueAgents: protoStats.uniqueAgents,
          note: "Live on-chain .ai Agent ID stats from BNB Smart Chain",
        }
      : {
          deployed: false,
          interactions: null,
          note: "On-chain interaction counts are not yet available",
        };

    res.json({
      ok: true,
      leaderboard: ranked,
      onChain,
    });
  });
};
