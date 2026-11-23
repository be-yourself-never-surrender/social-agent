// Social room + Group room API for agentics.forum (BNB Smart Chain .ai Agent IDs).
// Lounge reads are public. Crews are private: no public listing,
// crew reads require membership, and joining is only via invite
// link/code. Writes require an ACTIVE BAW session (via /api/pair)
// plus an on-chain .ai Agent ID (SPACE ID registry handleOf).
//
// Ported from the make.fun-era social.js (2026-11-20): search,
// trending, notifications, saved posts, threaded (X-style) comments
// with replies/reactions/moderation, and post view counts. All auth
// adapted to BAW sessions + Agent ID; no Solana / make.fun identity.
// Identity is always the session's verified address; handles resolve
// server-side through BSC RPC, never from client input.
// Storage: JSON file in the backend dir (not web-served), writes serialized.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const photos = require("./photos");
const referrals = require("./referrals");
const bluetick = require("./blue-tick");
const profiles = require("./profiles");
const adminAuth = require("./admin"); // requireAdmin for comment moderation

const DATA_FILE = process.env.SOCIAL_DATA || path.join(__dirname, "social.json");
const RPC_URL = process.env.BSC_RPC || process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";
const REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";
const REGISTRY_ABI = ["function handleOf(address) view returns (string)"];
// Text/photo limits are per-author (Blue Tick raises them); see blue-tick.js.
const MAX_NAME = 40;
const MAX_DESC = 200;
const COOLDOWN_MS = 5000;
const MODERATOR_ADDRESS = (process.env.MODERATOR_ADDRESS || "").toLowerCase();
const MAX_REASON = 200;
// Nested comments: anti-abuse limits (ported from make.fun-era social.js).
const COMMENT_COOLDOWN_MS = 30000; // comment-specific cooldown per address
const COMMENT_DAILY_CAP = 200; // comments per address per UTC day
const COMMENT_PARENT_HOUR_CAP = 3; // replies per (address, parent) per hour
const COMMENT_PARENT_DAY_CAP = 20; // replies per (address, parent) per UTC day
const COMMENT_DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMMENT_GET_RATE_LIMIT = 60; // GET comment endpoints per IP per minute
const COMMENT_GET_RATE_WINDOW_MS = 60 * 1000;
const MAX_REPORT_DETAILS = 500;
const HIDDEN_PLACEHOLDER = "[This reply was hidden by a moderator.]";
const DELETED_PLACEHOLDER = "[This reply was deleted by a moderator.]";
const COMMENT_REPORT_REASONS = ["harassment", "spam", "impersonation", "other"];
function isModerator(address) {
  return !!MODERATOR_ADDRESS && !!address && address.toLowerCase() === MODERATOR_ADDRESS;
}

let data = {
  messages: [],
  groups: [],
  memberships: [],
  nextGroupId: 1,
  nextMsgId: 1,
  handles: {},
  likes: [],
  postSaves: [],
  follows: [],
  comments: [],
  reposts: [],
  commentLikes: [],
  commentReposts: [],
  commentSaves: [],
  commentViewCounts: {},
  commentViewedBy: {},
  reports: [],
  viewCounts: {},
  viewedBy: {},
  nextCommentId: 1,
  legacyIds: {},
};
try {
  if (fs.existsSync(DATA_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    data = { ...data, ...loaded };
  }
} catch (e) {
  /* start fresh */
}
// Backward-compatible defaults for stores created before the port.
for (const key of ["postSaves", "commentLikes", "commentReposts", "commentSaves"]) {
  if (!Array.isArray(data[key])) data[key] = [];
}
if (!data.commentViewCounts || typeof data.commentViewCounts !== "object") data.commentViewCounts = {};
if (!data.commentViewedBy || typeof data.commentViewedBy !== "object") data.commentViewedBy = {};
if (!data.viewCounts || typeof data.viewCounts !== "object") data.viewCounts = {};
if (!data.viewedBy || typeof data.viewedBy !== "object") data.viewedBy = {};

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Post IDs are random 16-digit numbers (X-style), never sequential, so
// post URLs are not enumerable. Under 2^53, safe for JSON numbers.
function genMsgId() {
  let id;
  do {
    id = 1000000000000000 + Math.floor(Math.random() * 8000000000000000);
  } while (data.messages.some((m) => m.id === id));
  return id;
}
function genCode() {
  const buf = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return s;
}
function genUniqueCode() {
  let c;
  do {
    c = genCode();
  } while (data.groups.some((g) => g.inviteCode === c));
  return c;
}
function ensureCodes() {
  let changed = false;
  for (const g of data.groups) {
    if (!g.inviteCode) {
      g.inviteCode = genUniqueCode();
      changed = true;
    }
  }
  if (changed) save();
}
ensureCodes();

let writeQueue = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(data);
  writeQueue = writeQueue
    .then(() => fs.promises.writeFile(DATA_FILE + ".tmp", snapshot))
    .then(() => fs.promises.rename(DATA_FILE + ".tmp", DATA_FILE))
    .catch(() => {});
  return writeQueue;
}

const lastPostAt = new Map(); // address -> timestamp
const lastCommentAt = new Map(); // address -> timestamp (comment-specific 30s gate)
let provider = null;
function rpc() {
  if (!provider) provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  return provider;
}
async function resolveHandle(address) {
  if (data.handles[address]) return data.handles[address];
  try {
    const reg = new ethers.Contract(REGISTRY, REGISTRY_ABI, rpc());
    const handle = await reg.handleOf(address);
    if (handle) {
      data.handles[address] = handle;
      save();
      return handle;
    }
  } catch (e) {
    /* RPC hiccup: treat as no handle this time */
  }
  return null;
}

// sessions: the pairing backend's Map (sessionId -> session)
const { activeSession } = require("./session-check");

function authedSession(sessions, sessionId) {
  // Enforces ACTIVE + address + not past expireAt (see session-check.js).
  return activeSession(sessions, sessionId);
}

function likeCountOf(id) {
  return data.likes.filter((l) => l.messageId === id).length;
}
function commentCountOf(id) {
  return data.comments.filter((c) => c.postId === id).length;
}
function repostCountOf(id) {
  return data.reposts.filter((r) => r.messageId === id).length;
}
function postSaveCountOf(id) {
  return (data.postSaves || []).filter((r) => r.messageId === id).length;
}
function commentLikeCountOf(id) {
  return (data.commentLikes || []).filter((r) => r.commentId === id).length;
}
function commentRepostCountOf(id) {
  return (data.commentReposts || []).filter((r) => r.commentId === id).length;
}
function commentSaveCountOf(id) {
  return (data.commentSaves || []).filter((r) => r.commentId === id).length;
}
function commentViewCountOf(id) {
  return (data.commentViewCounts && data.commentViewCounts[id]) || 0;
}
// EVM address equality (case-insensitive). BAW equivalent of the
// make.fun-era identity.sameWallet (which also handled Solana base58).
function sameAddress(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}
// The parent a comment replies to, as a stable key: a nested reply keys
// by its parent comment id, a top-level reply keys by its root post id.
function commentParentKey(c) {
  if (!c) return null;
  if (c.parentCommentId != null) return "c:" + c.parentCommentId;
  return "p:" + c.postId;
}
// UTC calendar day (YYYY-MM-DD) for a timestamp.
function dayOf(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}
// One-pass comment stats: direct-children reply counts, per-post totals
// (all depths), and depths. Depth is a memoised walk up the parent map;
// a cycle or a walk over 1000 steps serves depth 1000 and logs the
// incident. An orphan (parent record missing) serves depth 1.
function buildCommentStats() {
  const replyCounts = new Map();
  const postTotals = new Map();
  const parentMap = new Map();
  for (const c of data.comments) {
    parentMap.set(c.id, c.parentCommentId == null ? null : c.parentCommentId);
    if (c.parentCommentId != null)
      replyCounts.set(c.parentCommentId, (replyCounts.get(c.parentCommentId) || 0) + 1);
    postTotals.set(c.postId, (postTotals.get(c.postId) || 0) + 1);
  }
  const depths = new Map();
  function depthOf(id) {
    if (depths.has(id)) return depths.get(id);
    let d = 0;
    const seen = new Set([id]);
    let cur = id;
    while (true) {
      const p = parentMap.get(cur);
      if (p == null) break;
      if (seen.has(p)) { d = 1000; break; }
      seen.add(p);
      d++;
      if (d >= 1000) { d = 1000; break; }
      if (!parentMap.has(p)) break;
      cur = p;
    }
    if (d >= 1000) console.error("comment depth cycle or limit", id);
    depths.set(id, d);
    return d;
  }
  return { replyCounts, postTotals, depthOf };
}
// GET comment endpoints rate limit: 60 requests per minute per IP.
// Returns true when the request may proceed; sends 429 and returns
// false when the limit is hit. A speed bump only, not an enumeration fix.
const commentGetHits = new Map();
function commentGetRateLimit(req, res) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const hits = (commentGetHits.get(ip) || []).filter(
    (t) => now - t < COMMENT_GET_RATE_WINDOW_MS
  );
  if (hits.length >= COMMENT_GET_RATE_LIMIT) {
    res.status(429).json({ error: "too_many_requests" });
    return false;
  }
  hits.push(now);
  commentGetHits.set(ip, hits);
  return true;
}
// View counts: one view per viewer per post per 24h. The viewer key is the
// client IP (req.ip; trust proxy is set, so it is the real client IP).
const VIEW_DEDUP_MS = 24 * 60 * 60 * 1000;
function recordView(messageId, viewerKey) {
  const now = Date.now();
  if (!data.viewCounts) data.viewCounts = {};
  if (!data.viewedBy) data.viewedBy = {};
  let seen = data.viewedBy[messageId];
  if (!seen) { seen = {}; data.viewedBy[messageId] = seen; }
  const last = seen[viewerKey];
  if (last && now - last < VIEW_DEDUP_MS) return false;
  seen[viewerKey] = now;
  data.viewCounts[messageId] = (data.viewCounts[messageId] || 0) + 1;
  for (const k of Object.keys(seen)) {
    if (now - seen[k] >= VIEW_DEDUP_MS) delete seen[k];
  }
  save();
  return true;
}
function viewCountOf(id) {
  return (data.viewCounts && data.viewCounts[id]) || 0;
}
function recordCommentView(commentId, viewerKey) {
  const now = Date.now();
  if (!data.commentViewCounts) data.commentViewCounts = {};
  if (!data.commentViewedBy) data.commentViewedBy = {};
  let seen = data.commentViewedBy[commentId];
  if (!seen) { seen = {}; data.commentViewedBy[commentId] = seen; }
  const last = seen[viewerKey];
  if (last && now - last < VIEW_DEDUP_MS) return false;
  seen[viewerKey] = now;
  data.commentViewCounts[commentId] = (data.commentViewCounts[commentId] || 0) + 1;
  for (const k of Object.keys(seen)) if (now - seen[k] >= VIEW_DEDUP_MS) delete seen[k];
  save();
  return true;
}
// Idempotent follow: adds the record only when it is not already there.
// Never toggles: an auto-follow must not re-follow a user who unfollowed.
function ensureFollow(follower, following) {
  const fl = follower.toLowerCase();
  const fo = following.toLowerCase();
  if (
    data.follows.some(
      (f) =>
        f.follower.toLowerCase() === fl && f.following.toLowerCase() === fo
    )
  )
    return false;
  data.follows.push({ follower, following });
  return true;
}
function publicMsg(m, stats) {
  const s = stats || buildCommentStats();
  return {
    id: m.id,
    address: m.address,
    handle: m.handle,
    verified: bluetick.isVerifiedAddress(m.address),
    avatarUrl: profiles.avatarUrlFor(m.handle),
    text: m.text,
    image: m.image || null,
    images: m.images || (m.image ? [m.image] : []),
    editedAt: m.editedAt || null,
    ts: m.ts,
    likeCount: likeCountOf(m.id),
    saveCount: postSaveCountOf(m.id),
    commentCount: s.postTotals.get(m.id) || 0,
    repostCount: repostCountOf(m.id),
    viewCount: viewCountOf(m.id),
  };
}
function publicComment(c, stats) {
  const s = stats || buildCommentStats();
  const hidden = !!c.hidden;
  const deleted = !!c.deleted;
  let text = c.text;
  if (deleted) text = DELETED_PLACEHOLDER;
  else if (hidden) text = HIDDEN_PLACEHOLDER;
  return {
    id: c.id,
    postId: c.postId,
    parentCommentId: c.parentCommentId == null ? null : c.parentCommentId,
    depth: s.depthOf(c.id),
    replyCount: s.replyCounts.get(c.id) || 0,
    likeCount: commentLikeCountOf(c.id),
    repostCount: commentRepostCountOf(c.id),
    saveCount: commentSaveCountOf(c.id),
    viewCount: commentViewCountOf(c.id),
    address: c.address,
    handle: c.handle,
    verified: bluetick.isVerifiedAddress(c.address),
    avatarUrl: profiles.avatarUrlFor(c.handle),
    text,
    ts: c.ts,
    hidden,
    deleted,
  };
}
// Resolve a message id, including legacy pre-migration ids.
function findMessage(id) {
  let m = data.messages.find((x) => x.id === id);
  if (m) return m;
  const nid = data.legacyIds && data.legacyIds[id];
  if (nid) return data.messages.find((x) => x.id === nid) || null;
  return null;
}

// Delete a Lounge post and everything attached to it: comments, likes,
// reposts, open reports, and its photo file + record when it has one.
// Group messages are never deleted through this path.
async function deletePostCascade(msg) {
  data.messages = data.messages.filter((m) => m.id !== msg.id);
  data.comments = data.comments.filter((c) => c.postId !== msg.id);
  data.likes = data.likes.filter((l) => l.messageId !== msg.id);
  data.reposts = data.reposts.filter((r) => r.messageId !== msg.id);
  data.reports = data.reports.filter((r) => r.postId !== msg.id);
  const imgs =
    msg.images && msg.images.length ? msg.images : msg.image ? [msg.image] : [];
  for (const im of imgs) {
    if (im && im.photoId) await photos.removePhoto(im.photoId);
  }
}

module.exports = function registerSocial(app, sessions) {
  // One-time migration: legacy sequential message ids (< 1e15) become
  // random 16-digit post ids (Twitter-style). Old ids stay resolvable
  // via data.legacyIds, so old links load and canonicalize to the new
  // id. Persisted synchronously before serving, so a crash cannot
  // leave served ids unpersisted; later boots are a no-op.
  if (!data.legacyIds) data.legacyIds = {};
  let migrated = false;
  for (const m of data.messages) {
    if (m.id < 1000000000000000) {
      const oldId = m.id;
      const newId = genMsgId();
      data.legacyIds[oldId] = newId;
      for (const l of data.likes) if (l.messageId === oldId) l.messageId = newId;
      for (const r of data.reposts) if (r.messageId === oldId) r.messageId = newId;
      for (const c of data.comments) if (c.postId === oldId) c.postId = newId;
      m.id = newId;
      migrated = true;
    }
  }
  if (migrated) {
    try {
      fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(data));
      fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
    } catch (e) { /* next boot retries; in-memory data is already migrated */ }
  }
  app.get("/api/social/messages", (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const list = data.messages.filter((m) => m.room === "social").slice(-limit);
    res.json({ messages: list.map((m) => publicMsg(m)) });
  });

  // Mixed Lounge feed: all public posts, plus repost items from accounts
  // the viewer follows (and their own reposts). Unpaired viewers get posts
  // only. Repost items render with a "handle reposted" header and, for
  // quote reposts, the quoter's text above the embedded original.
  app.post("/api/social/feed", (req, res) => {
    const { session } = activeSession(
      sessions,
      req.body && req.body.sessionId
    );
    const viewer = session ? session.address : null;
    const following = new Set();
    if (viewer) {
      data.follows.forEach((f) => {
        if (f.follower === viewer) following.add(f.following.toLowerCase());
      });
    }
    const items = data.messages
      .filter((m) => m.room === "social")
      .slice(-50)
      .map((m) => ({ kind: "post", ...publicMsg(m) }));
    if (viewer) {
      const vl = viewer.toLowerCase();
      data.reposts.forEach((r) => {
        const rl = r.address.toLowerCase();
        if (rl !== vl && !following.has(rl)) return;
        const orig = data.messages.find((m) => m.id === r.messageId);
        if (!orig || orig.room !== "social") return;
        items.push({
          kind: "repost",
          reposterAddress: r.address,
          reposterHandle: r.handle || data.handles[r.address] || null,
          reposterVerified: bluetick.isVerifiedAddress(r.address),
          quote: r.text || null,
          ts: r.ts,
          message: publicMsg(orig),
        });
      });
    }
    items.sort((a, b) => b.ts - a.ts);
    res.json({ items: items.slice(0, 50) });
  });

  app.get("/api/social/messages/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const m = findMessage(id);
    if (!m || m.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    res.json(publicMsg(m));
  });

  app.get("/api/social/messages/:id/comments", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const m = findMessage(id);
    if (!m || m.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const list = data.comments.filter((c) => c.postId === m.id);
    res.json({ comments: list.map((c) => publicComment(c)) });
  });

  app.post("/api/social/messages", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const text =
      typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "invalid_text" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (text.length > await bluetick.maxTextForAddress(session.address))
      return res.status(400).json({ error: "invalid_text" });
    // Photos: photoIds (array) or legacy photoId (single string).
    // Blue Tick raises the per-post limit (5 vs 2).
    let photoIds = [];
    if (Array.isArray(req.body.photoIds)) {
      photoIds = req.body.photoIds
        .filter((x) => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean);
    } else if (
      typeof req.body.photoId === "string" &&
      req.body.photoId.trim()
    ) {
      photoIds = [req.body.photoId.trim()];
    }
    photoIds = [...new Set(photoIds)];
    if (photoIds.length > await bluetick.maxPhotosForAddress(session.address))
      return res.status(400).json({ error: "too_many_photos" });
    const photoObjs = [];
    for (const pid of photoIds) {
      const p = photos.getPhoto(pid);
      if (!p) return res.status(400).json({ error: "invalid_photo" });
      if (p.owner !== session.address)
        return res.status(403).json({ error: "not_photo_owner" });
      if (p.usedBy) return res.status(409).json({ error: "photo_used" });
      photoObjs.push(p);
    }
    const now = Date.now();
    if (now - (lastPostAt.get(session.address) || 0) < COOLDOWN_MS) {
      return res.status(429).json({ error: "too_fast" });
    }
    lastPostAt.set(session.address, now);
    const images = photoObjs.map((p) => ({
      photoId: p.id,
      url: p.url,
      width: p.width,
      height: p.height,
    }));
    const msg = {
      id: genMsgId(),
      room: "social",
      groupId: null,
      address: session.address,
      handle,
      text,
      image: images[0] || null,
      images,
      ts: now,
    };
    data.messages.push(msg);
    for (const p of photoObjs) await photos.markUsed(p.id, msg.id);
    await save();
    res.json({ message: publicMsg(msg) });
  });

  // ---- Moderation (Lounge posts only) ----
  // Delete own post, report any post, moderator deletes any post and
  // reviews open reports. The moderator is a single address configured
  // on the server via MODERATOR_ADDRESS (never client input).
  app.post("/api/social/messages/:id/delete", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const msgId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === msgId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (msg.address.toLowerCase() !== session.address.toLowerCase())
      return res.status(403).json({ error: "not_author" });
    await deletePostCascade(msg);
    await save();
    res.json({ ok: true, deleted: msgId });
  });

  // Edit own Lounge post (Blue Tick feature): author only, must be
  // currently verified. No edit history in v1; the post carries an
  // editedAt timestamp the frontend renders as an "Edited" label.
  app.post("/api/social/messages/:id/edit", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const msgId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === msgId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "not_found" });
    if (msg.address.toLowerCase() !== session.address.toLowerCase())
      return res.status(403).json({ error: "not_author" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (!(await bluetick.verifyAddress(session.address)).verified)
      return res.status(403).json({ error: "not_verified" });
    const text =
      typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "invalid_text" });
    if (text.length > bluetick.MAX_TEXT_VERIFIED)
      return res.status(400).json({ error: "text_too_long" });
    msg.text = text;
    msg.editedAt = Date.now();
    await save();
    res.json({ message: publicMsg(msg) });
  });

  app.post("/api/social/messages/:id/report", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const msgId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === msgId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const reason =
      typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length > MAX_REASON)
      return res.status(400).json({ error: "invalid_reason" });
    if (
      data.reports.some(
        (r) => r.postId === msgId && r.reporter === session.address
      )
    )
      return res.status(409).json({ error: "already_reported" });
    const report = {
      id: crypto.randomBytes(8).toString("hex"),
      postId: msgId,
      reporter: session.address,
      reporterHandle: handle,
      reason,
      ts: Date.now(),
    };
    data.reports.push(report);
    await save();
    res.json({ ok: true, report });
  });

  app.post("/api/social/reports", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (!isModerator(session.address))
      return res.status(403).json({ error: "not_moderator" });
    const list = [];
    for (const r of data.reports) {
      const post = data.messages.find((m) => m.id === r.postId);
      if (!post || post.room !== "social") continue;
      list.push({
        id: r.id,
        postId: r.postId,
        postText: post.text,
        postImage: post.image ? post.image.url : null,
        postAuthor: post.address,
        postHandle: post.handle,
        reporter: r.reporter,
        reporterHandle: r.reporterHandle,
        reason: r.reason,
        ts: r.ts,
      });
    }
    res.json({ reports: list });
  });

  app.post("/api/social/reports/:id/resolve", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (!isModerator(session.address))
      return res.status(403).json({ error: "not_moderator" });
    const idx = data.reports.findIndex((r) => r.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: "report_not_found" });
    data.reports.splice(idx, 1);
    await save();
    res.json({ ok: true });
  });

  app.post("/api/social/messages/:id/moderate-delete", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const msgId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === msgId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (!isModerator(session.address))
      return res.status(403).json({ error: "not_moderator" });
    await deletePostCascade(msg);
    await save();
    res.json({ ok: true, deleted: msgId });
  });

  // ---- Referrals ----
  // The referrer comes from the ?ref= link (resolved on-chain by the
  // frontend); the backend records it once (first-applied wins) and
  // creates the auto-follow immediately. The bonus (+1 paid allocation)
  // is NOT counted here: it accrues only on the invitee's first paid
  // mint, which is enforced at mint time once contracts deploy.
  app.post("/api/social/referral", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const referrer =
      typeof req.body.referrer === "string" ? req.body.referrer.trim() : "";
    if (!ethers.utils.isAddress(referrer))
      return res.status(400).json({ error: "invalid_referrer" });
    if (referrer.toLowerCase() === session.address.toLowerCase())
      return res.status(400).json({ error: "self_referral" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const referrerHandle = await resolveHandle(referrer);
    if (!referrerHandle)
      return res.status(403).json({ error: "referrer_agent_id_required" });
    const { record, created } = await referrals.recordReferral(
      session.address,
      referrer
    );
    let followed = false;
    if (created) followed = ensureFollow(session.address, referrer);
    await save();
    res.json({
      ok: true,
      referrer: record.referrer,
      alreadyRecorded: !created,
      followed,
    });
  });

  app.post("/api/social/referral/mine", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const rec = referrals.getReferral(session.address);
    res.json({
      referrer: rec ? rec.referrer : null,
      successfulCount: referrals.countSuccessful(session.address),
    });
  });

  app.post("/api/social/groups", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const name =
      typeof req.body.name === "string" ? req.body.name.trim() : "";
    const description =
      typeof req.body.description === "string"
        ? req.body.description.trim()
        : "";
    if (!name || name.length > MAX_NAME || description.length > MAX_DESC) {
      return res.status(400).json({ error: "invalid_group" });
    }
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const group = {
      id: data.nextGroupId++,
      name,
      description,
      creator: session.address,
      createdAt: Date.now(),
      inviteCode: genUniqueCode(),
    };
    data.groups.push(group);
    data.memberships.push({ groupId: group.id, address: session.address });
    await save();
    res.json({ group: { ...group, memberCount: 1 } });
  });

  app.post("/api/social/groups/:id/read", (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const groupId = parseInt(req.params.id, 10);
    if (!data.groups.some((g) => g.id === groupId))
      return res.status(404).json({ error: "group_not_found" });
    if (
      !data.memberships.some(
        (m) => m.groupId === groupId && m.address === session.address
      )
    ) {
      return res.status(403).json({ error: "not_member" });
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.body.limit, 10) || 50));
    const list = data.messages
      .filter((m) => m.groupId === groupId)
      .slice(-limit);
    res.json({ messages: list.map((m) => publicMsg(m)) });
  });

  app.post("/api/social/groups/:id/messages", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const groupId = parseInt(req.params.id, 10);
    const group = data.groups.find((g) => g.id === groupId);
    if (!group) return res.status(404).json({ error: "group_not_found" });
    const text =
      typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "invalid_text" });
    if (
      !data.memberships.some(
        (m) => m.groupId === groupId && m.address === session.address
      )
    ) {
      return res.status(403).json({ error: "not_member" });
    }
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (text.length > await bluetick.maxTextForAddress(session.address))
      return res.status(400).json({ error: "invalid_text" });
    const now = Date.now();
    if (now - (lastPostAt.get(session.address) || 0) < COOLDOWN_MS) {
      return res.status(429).json({ error: "too_fast" });
    }
    lastPostAt.set(session.address, now);
    const msg = {
      id: genMsgId(),
      room: "group",
      groupId,
      address: session.address,
      handle,
      text,
      ts: now,
    };
    data.messages.push(msg);
    await save();
    res.json({ message: publicMsg(msg) });
  });

  app.post("/api/social/messages/:id/like", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const msgId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === msgId);
    if (!msg) return res.status(404).json({ error: "message_not_found" });
    if (
      msg.room === "group" &&
      !data.memberships.some(
        (m) => m.groupId === msg.groupId && m.address === session.address
      )
    ) {
      return res.status(403).json({ error: "not_member" });
    }
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const idx = data.likes.findIndex(
      (l) => l.messageId === msgId && l.address === session.address
    );
    let liked;
    if (idx >= 0) {
      data.likes.splice(idx, 1);
      liked = false;
    } else {
      data.likes.push({ messageId: msgId, address: session.address, ts: Date.now() });
      liked = true;
    }
    await save();
    res.json({ liked, likeCount: likeCountOf(msgId) });
  });

  app.post("/api/social/liked", (req, res) => {
    const { session: s } = activeSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (!s || !s.address) return res.json({ likedIds: [] });
    const ids = Array.isArray(req.body.ids)
      ? req.body.ids
          .map((x) => parseInt(x, 10))
          .filter((x) => !isNaN(x))
          .slice(0, 100)
      : [];
    const likedIds = data.likes
      .filter((l) => l.address === s.address && ids.includes(l.messageId))
      .map((l) => l.messageId);
    res.json({ likedIds });
  });

  app.post("/api/social/follow", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const target =
      typeof req.body.target === "string" ? req.body.target.trim() : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(target))
      return res.status(400).json({ error: "invalid_target" });
    if (target.toLowerCase() === session.address.toLowerCase())
      return res.status(400).json({ error: "cannot_follow_self" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const idx = data.follows.findIndex(
      (f) =>
        f.follower === session.address &&
        f.following.toLowerCase() === target.toLowerCase()
    );
    let following;
    if (idx >= 0) {
      data.follows.splice(idx, 1);
      following = false;
    } else {
      data.follows.push({ follower: session.address, following: target, ts: Date.now() });
      following = true;
    }
    await save();
    res.json({
      following,
      followersCount: data.follows.filter(
        (f) => f.following.toLowerCase() === target.toLowerCase()
      ).length,
    });
  });

  app.post("/api/social/profile", async (req, res) => {
    const addr =
      typeof req.body.address === "string" ? req.body.address.trim() : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const lower = addr.toLowerCase();
    const handle =
      data.handles[addr] || data.handles[lower] || (await resolveHandle(addr));
    const { session: viewer } = activeSession(sessions, req.body.sessionId);
    const viewerAddr = viewer && viewer.address ? viewer.address : null;
    const likesReceived = data.messages
      .filter((m) => m.address.toLowerCase() === lower && m.room === "social")
      .reduce((sum, m) => sum + likeCountOf(m.id), 0);
    const btStatus = await bluetick.verifyAddress(addr);
    res.json({
      address: addr,
      handle: handle || null,
      avatarUrl: handle ? profiles.avatarUrlFor(handle) : null,
      bannerUrl: handle ? profiles.bannerUrlFor(handle) : null,
      bio: handle ? profiles.bioFor(handle) : null,
      verified: !!btStatus.verified,
      checkIns: btStatus.checkIns || 0,
      streak: btStatus.streak || 0,
      lastCheckIn: btStatus.lastCheckIn || null,
      followingCount: data.follows.filter(
        (f) => f.follower.toLowerCase() === lower
      ).length,
      followersCount: data.follows.filter(
        (f) => f.following.toLowerCase() === lower
      ).length,
      likesReceived,
      postsCount: data.messages.filter(
        (m) => m.address.toLowerCase() === lower && m.room === "social"
      ).length,
      following: viewerAddr
        ? data.follows.some(
            (f) =>
              f.follower === viewerAddr &&
              f.following.toLowerCase() === lower
          )
        : false,
    });
  });

  app.get("/api/social/profile/:address/posts", (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const lower = addr.toLowerCase();
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const list = data.messages
      .filter((m) => m.address.toLowerCase() === lower && m.room === "social")
      .slice(-limit)
      .reverse();
    res.json({ messages: list.map((m) => publicMsg(m)) });
  });

  app.post("/api/social/my-groups", (req, res) => {
    const auth = authedSession(sessions, req.body && req.body.sessionId);
    if (auth.error) return res.status(auth.code).json({ error: auth.error });
    const addr = auth.session.address;
    const mine = data.groups.filter(
      (g) =>
        g.creator === addr ||
        data.memberships.some(
          (m) => m.groupId === g.id && m.address === addr
        )
    );
    const mapped = mine.map((g) => {
      const msgs = data.messages.filter((m) => m.groupId === g.id);
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      return {
        id: g.id,
        name: g.name,
        description: g.description,
        creator: g.creator,
        createdAt: g.createdAt,
        inviteCode: g.inviteCode || null,
        memberCount: data.memberships.filter((m) => m.groupId === g.id)
          .length,
        lastMessage: last
          ? {
              text: last.text,
              ts: last.ts,
              handle: last.handle,
              address: last.address,
            }
          : null,
      };
    });
    mapped.sort(
      (a, b) =>
        (b.lastMessage ? b.lastMessage.ts : b.createdAt) -
        (a.lastMessage ? a.lastMessage.ts : a.createdAt)
    );
    res.json({ groups: mapped });
  });

  // Crew member list: members only. Used by the crew info panel.
  // Returns every member (creator first is NOT guaranteed; the frontend
  // shows the role badge from the creator address).
  app.post("/api/social/groups/:id/members", (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const groupId = parseInt(req.params.id, 10);
    const group = data.groups.find((g) => g.id === groupId);
    if (!group) return res.status(404).json({ error: "group_not_found" });
    if (
      !data.memberships.some(
        (m) => m.groupId === groupId && m.address === session.address
      )
    ) {
      return res.status(403).json({ error: "not_member" });
    }
    const members = data.memberships
      .filter((m) => m.groupId === groupId)
      .map((m) => ({
        address: m.address,
        handle: data.handles[m.address] || null,
        verified: bluetick.isVerifiedAddress(m.address),
        role: m.address === group.creator ? "Owner" : "Member",
      }));
    res.json({ members });
  });

  app.post("/api/social/groups/join-by-code", async (req, res) => {
    const auth = authedSession(sessions, req.body && req.body.sessionId);
    if (auth.error) return res.status(auth.code).json({ error: auth.error });
    const session = auth.session;
    const raw =
      typeof req.body.code === "string" ? req.body.code.trim() : "";
    const m = raw.match(/code=([A-Za-z0-9]+)/i);
    const code = (m ? m[1] : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const group = data.groups.find(
      (g) => g.inviteCode && g.inviteCode.toUpperCase() === code
    );
    if (!group) return res.status(404).json({ error: "crew_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (
      !data.memberships.some(
        (m) => m.groupId === group.id && m.address === session.address
      )
    ) {
      data.memberships.push({ groupId: group.id, address: session.address });
      await save();
    }
    res.json({
      group: {
        id: group.id,
        name: group.name,
        description: group.description,
        inviteCode: group.inviteCode,
        memberCount: data.memberships.filter((m) => m.groupId === group.id)
          .length,
      },
    });
  });

  app.post("/api/social/comments", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const postId = parseInt(req.body.postId, 10);
    const post = data.messages.find((m) => m.id === postId);
    if (!post || post.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const text =
      typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "invalid_text" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (text.length > await bluetick.maxTextForAddress(session.address))
      return res.status(400).json({ error: "invalid_text" });
    // Parent validation (nested reply only).
    let parentCommentId = null;
    if (req.body.parentCommentId !== undefined && req.body.parentCommentId !== null) {
      parentCommentId = parseInt(req.body.parentCommentId, 10);
      const parent = data.comments.find((c) => c.id === parentCommentId);
      if (!parent) return res.status(404).json({ error: "parent_not_found" });
      if (parent.postId !== postId)
        return res.status(400).json({ error: "parent_wrong_post" });
    }
    // Comments have no photos in v1.
    if (
      (Array.isArray(req.body.photoIds) && req.body.photoIds.length) ||
      (typeof req.body.photoId === "string" && req.body.photoId.trim())
    ) {
      return res.status(400).json({ error: "invalid_comment" });
    }
    const now = Date.now();
    const parentKey = parentCommentId != null ? "c:" + parentCommentId : "p:" + postId;
    const today = dayOf(now);
    // Duplicate guard: same address, identical trimmed text, same
    // parent, within 24 hours. Stops double-submit and naive retries.
    if (
      data.comments.some(
        (c) =>
          c.address === session.address &&
          c.text === text &&
          commentParentKey(c) === parentKey &&
          now - c.ts < COMMENT_DUPLICATE_WINDOW_MS
      )
    ) {
      return res.status(409).json({ error: "duplicate_reply" });
    }
    // Cooldowns: the shared 5s gate plus a comment-specific 30s gate.
    if (now - (lastPostAt.get(session.address) || 0) < COOLDOWN_MS) {
      return res.status(429).json({ error: "too_fast" });
    }
    if (now - (lastCommentAt.get(session.address) || 0) < COMMENT_COOLDOWN_MS) {
      return res.status(429).json({ error: "comment_too_fast" });
    }
    // Per-address daily volume cap: 200 comments per UTC day.
    const todayCount = data.comments.filter(
      (c) => c.address === session.address && dayOf(c.ts) === today
    ).length;
    if (todayCount >= COMMENT_DAILY_CAP) {
      return res.status(429).json({ error: "rate_limited" });
    }
    // Per-parent rate limit: 3 per (address, parent) per hour and
    // 20 per (address, parent) per UTC day.
    const hourCount = data.comments.filter(
      (c) =>
        c.address === session.address &&
        commentParentKey(c) === parentKey &&
        now - c.ts < 60 * 60 * 1000
    ).length;
    if (hourCount >= COMMENT_PARENT_HOUR_CAP) {
      return res.status(429).json({ error: "parent_rate_limited" });
    }
    const parentDayCount = data.comments.filter(
      (c) =>
        c.address === session.address &&
        commentParentKey(c) === parentKey &&
        dayOf(c.ts) === today
    ).length;
    if (parentDayCount >= COMMENT_PARENT_DAY_CAP) {
      return res.status(429).json({ error: "parent_rate_limited" });
    }
    lastPostAt.set(session.address, now);
    lastCommentAt.set(session.address, now);
    const comment = {
      id: data.nextCommentId++,
      postId,
      parentCommentId,
      address: session.address,
      handle,
      text,
      ts: now,
      hidden: false,
      deleted: false,
    };
    data.comments.push(comment);
    await save();
    res.json({ comment: publicComment(comment, buildCommentStats()) });
  });

  app.get("/api/social/comments", (req, res) => {
    const postId = parseInt(req.query.postId, 10);
    if (isNaN(postId)) return res.status(400).json({ error: "invalid_post" });
    let list = data.comments.filter((c) => c.postId === postId);
    if (req.query.topLevel === "1") {
      list = list.filter((c) => c.parentCommentId == null);
    } else if (req.query.parentCommentId !== undefined) {
      const pid = parseInt(req.query.parentCommentId, 10);
      list = list.filter((c) => c.parentCommentId === pid);
    }
    list = list.slice(-50);
    const viewerKey = "ip:" + (req.ip || "unknown");
    list.forEach((c) => recordCommentView(c.id, viewerKey));
    const stats = buildCommentStats();
    res.json({ comments: list.map((c) => publicComment(c, stats)) });
  });

  app.post("/api/social/repost", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const messageId = parseInt(req.body.messageId, 10);
    const msg = data.messages.find((m) => m.id === messageId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const idx = data.reposts.findIndex(
      (r) => r.messageId === messageId && r.address === session.address
    );
    let reposted;
    if (idx >= 0) {
      data.reposts.splice(idx, 1);
      reposted = false;
    } else {
      data.reposts.push({
        messageId,
        address: session.address,
        ts: Date.now(),
        handle,
      });
      reposted = true;
    }
    await save();
    res.json({ reposted, repostCount: repostCountOf(messageId) });
  });

  // Quote repost: a repost carrying the quoter's own text. One record per
  // user per post: quoting an existing plain repost upgrades it (and moves
  // it to the quote time); quoting again updates the text. Same 5s
  // cooldown as posts and comments, since a quote is a feed-visible item.
  app.post("/api/social/messages/:id/quote", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const messageId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === messageId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const text =
      typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "invalid_text" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (text.length > await bluetick.maxTextForAddress(session.address))
      return res.status(400).json({ error: "invalid_text" });
    const now = Date.now();
    if (now - (lastPostAt.get(session.address) || 0) < COOLDOWN_MS) {
      return res.status(429).json({ error: "too_fast" });
    }
    lastPostAt.set(session.address, now);
    const rec = data.reposts.find(
      (r) => r.messageId === messageId && r.address === session.address
    );
    if (rec) {
      rec.text = text;
      rec.ts = now;
      rec.handle = handle;
    } else {
      data.reposts.push({
        messageId,
        address: session.address,
        ts: now,
        text,
        handle,
      });
    }
    await save();
    res.json({ quoted: true, repostCount: repostCountOf(messageId) });
  });

  app.post("/api/social/reposted", (req, res) => {
    const { session: s } = activeSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (!s || !s.address) return res.json({ repostedIds: [] });
    const ids = Array.isArray(req.body.ids)
      ? req.body.ids
          .map((x) => parseInt(x, 10))
          .filter((x) => !isNaN(x))
          .slice(0, 100)
      : [];
    const repostedIds = data.reposts
      .filter((r) => r.address === s.address && ids.includes(r.messageId))
      .map((r) => r.messageId);
    res.json({ repostedIds });
  });

  app.get("/api/social/profile/:address/comments", (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const lower = addr.toLowerCase();
    const list = data.comments
      .filter((c) => c.address.toLowerCase() === lower)
      .slice(-50)
      .reverse()
      .map((c) => {
        const post = data.messages.find((m) => m.id === c.postId);
        return {
          ...publicComment(c),
          post: post
            ? {
                id: post.id,
                address: post.address,
                handle: post.handle,
                verified: bluetick.isVerifiedAddress(post.address),
                text: post.text,
              }
            : null,
        };
      });
    res.json({ comments: list });
  });

  app.get("/api/social/profile/:address/reposts", (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const lower = addr.toLowerCase();
    const list = data.reposts
      .filter((r) => r.address.toLowerCase() === lower)
      .sort((a, b) => b.ts - a.ts)
      .map((r) => {
        const m = data.messages.find((x) => x.id === r.messageId);
        if (!m || m.room !== "social") return null;
        return { message: publicMsg(m), quote: r.text || null, ts: r.ts };
      })
      .filter(Boolean)
      .slice(0, 50);
    res.json({ reposts: list });
  });

  app.get("/api/social/profile/:address/likes", (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const lower = addr.toLowerCase();
    const likedIds = new Set(
      data.likes
        .filter((l) => l.address.toLowerCase() === lower)
        .map((l) => l.messageId)
    );
    const list = data.messages
      .filter((m) => likedIds.has(m.id) && m.room === "social")
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 50);
    res.json({ messages: list.map((m) => publicMsg(m)) });
  });

  // ---- Collection: on-chain holdings via public BSC RPC ----
  // No free no-key indexer covers BSC holdings (BscScan and Etherscan
  // V2 need a key, Blockscout BSC is unreachable), so v1 reads native
  // BNB plus balanceOf for a tracked, on-chain-verified token list,
  // and Agent ID NFTs via the registry balanceOf. Only nonzero
  // balances are returned; trackedOnly flags the partial coverage.
  const BSC_RPCS = [
    RPC_URL,
    "https://bsc-dataseed1.bnbchain.org",
    "https://bsc-dataseed2.bnbchain.org",
    "https://bsc-dataseed3.bnbchain.org",
    "https://bsc-dataseed4.bnbchain.org",
  ];
  async function bscRpc(method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 });
    for (const url of BSC_RPCS) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(5000),
        });
        const j = await r.json();
        if (j && j.result && j.result !== "0x") return j.result;
      } catch (e) { /* next mirror */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  }
  function fmtUnits(raw, decimals) {
    try {
      const v = BigInt(raw);
      const base = 10n ** BigInt(decimals);
      const whole = v / base;
      const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
      return frac ? whole.toString() + "." + frac : whole.toString();
    } catch (e) { return null; }
  }
  const BALANCE_OF = "0x70a08231";
  const TRACKED_TOKENS = [
    { address: "0xbb4CdB9CBd4b0a98055Ae8aE4B7D3bC41a9e3b2e1", name: "Wrapped BNB", symbol: "WBNB", decimals: 18 },
    { address: "0x55d398326f99059fF775485246999027B3197955", name: "Tether USD", symbol: "USDT", decimals: 18 },
    { address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", name: "BUSD Token", symbol: "BUSD", decimals: 18 },
    { address: "0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15", name: "JAGENT", symbol: "JAGENT", decimals: 18 },
    { address: "0x0810c5eb5d86d1B8D408F75Bd1f5ABeFb6d79999", name: "Initial Agent Offering", symbol: "IAO", decimals: 18 },
    { address: "0x15e47c22df42D94Fa2f0aD078Fec5Bea6453d5cF", name: "NIULAI", symbol: "NIULAI", decimals: 18 },
    { address: "0x0c876f2f7c44cde660ab77bd2022537a305e0220", name: "FIST Agent", symbol: "FAGENT", decimals: 18 },
  ];
  app.get("/api/social/profile/:address/tokens", async (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const tokens = [];
    let anyOk = false;
    const bnbRaw = await bscRpc("eth_getBalance", [addr, "latest"]);
    if (bnbRaw) {
      anyOk = true;
      const bal = fmtUnits(bnbRaw, 18);
      if (bal && bal !== "0") tokens.push({ symbol: "BNB", name: "BNB", balance: bal, contract: null });
    }
    const pad = addr.slice(2).toLowerCase().padStart(64, "0");
    for (const t of TRACKED_TOKENS) {
      const raw = await bscRpc("eth_call", [{ to: t.address, data: BALANCE_OF + pad }, "latest"]);
      if (!raw) continue;
      anyOk = true;
      const bal = fmtUnits(raw, t.decimals);
      if (bal && bal !== "0") tokens.push({ symbol: t.symbol, name: t.name, balance: bal, contract: t.address });
    }
    if (!anyOk) return res.status(502).json({ error: "collection_unavailable" });
    res.json({ tokens, trackedOnly: true });
  });
  app.get("/api/social/profile/:address/nfts", async (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const pad = addr.slice(2).toLowerCase().padStart(64, "0");
    const raw = await bscRpc("eth_call", [{ to: REGISTRY, data: BALANCE_OF + pad }, "latest"]);
    if (!raw) return res.status(502).json({ error: "collection_unavailable" });
    const count = Number(BigInt(raw));
    if (!count) return res.json({ nfts: [], more: 0 });
    let handle = null;
    for (const [k, v] of Object.entries(data.handles)) {
      if (k.toLowerCase() === addr.toLowerCase()) { handle = v; break; }
    }
    let tokenId = null;
    if (handle) {
      try { tokenId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(handle)); } catch (e) {}
    }
    const nfts = handle
      ? [{ name: handle + ".ai", tokenId, image: null }]
      : [{ name: "Agent ID NFT", tokenId: null, image: null }];
    res.json({ nfts, more: Math.max(0, count - 1) });
  });

  // ---- Saved posts (ported from make.fun-era) ----
  app.post("/api/social/saved", (req, res) => {
    const s = sessions.get(req.body && req.body.sessionId);
    if (!s || !s.address) return res.json({ savedIds: [] });
    const ids = Array.isArray(req.body.ids)
      ? req.body.ids.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0).slice(0, 100)
      : [];
    const savedIds = (data.postSaves || []).filter((r) => r.address.toLowerCase() === s.address.toLowerCase() && ids.includes(r.messageId)).map((r) => r.messageId);
    res.json({ savedIds });
  });

  app.post("/api/social/messages/:id/save", async (req, res) => {
    const { session, error, code } = authedSession(sessions, req.body && req.body.sessionId);
    if (error) return res.status(code).json({ error });
    const id = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === id && m.room === "social");
    if (!msg) return res.status(404).json({ error: "post_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const idx = data.postSaves.findIndex((r) => r.messageId === id && sameAddress(r.address, session.address));
    let saved;
    if (idx >= 0) { data.postSaves.splice(idx, 1); saved = false; }
    else { data.postSaves.push({ messageId: id, address: session.address, handle, ts: Date.now() }); saved = true; }
    await save();
    res.json({ saved, saveCount: postSaveCountOf(id) });
  });

  // ---- Threaded comments (X-style, ported from make.fun-era) ----
  // Single comment page data (public, no session). The caller MUST pass
  // the root post id as ?postId=; a mismatch is 404, so walking
  // sequential comment ids without a known post id yields nothing.
  // Hidden/deleted comments return the placeholder text, never the original.
  app.get("/api/social/comments/:id", (req, res) => {
    if (!commentGetRateLimit(req, res)) return;
    const id = parseInt(req.params.id, 10);
    const postId = parseInt(req.query.postId, 10);
    const c = data.comments.find((x) => x.id === id);
    if (!c || isNaN(postId) || c.postId !== postId)
      return res.status(404).json({ error: "comment_not_found" });
    const stats = buildCommentStats();
    // Full ancestor chain, root-first (grandparent ... direct parent).
    const ancestors = [];
    const seenChain = new Set([c.id]);
    let cur = c;
    while (cur.parentCommentId != null) {
      const p = data.comments.find((x) => x.id === cur.parentCommentId);
      if (!p || seenChain.has(p.id)) break;
      seenChain.add(p.id);
      ancestors.unshift(p);
      cur = p;
    }
    const parent = ancestors.length ? ancestors[ancestors.length - 1] : null;
    const rootPost = findMessage(c.postId);
    if (!rootPost || rootPost.room !== "social")
      return res.status(404).json({ error: "comment_not_found" });
    const viewerKey = "ip:" + (req.ip || "unknown");
    recordCommentView(c.id, viewerKey);
    for (const a of ancestors) recordCommentView(a.id, viewerKey);
    res.json({
      comment: publicComment(c, stats),
      parentComment: parent ? publicComment(parent, stats) : null,
      ancestors: ancestors.map((a) => publicComment(a, stats)),
      rootPost: publicMsg(rootPost, stats),
    });
  });

  // Direct children of a comment (public, no session). The client renders
  // the first 3, then pages of 50 (offset = count already rendered).
  app.get("/api/social/comments/:id/replies", (req, res) => {
    if (!commentGetRateLimit(req, res)) return;
    const id = parseInt(req.params.id, 10);
    const c = data.comments.find((x) => x.id === id);
    if (!c) return res.status(404).json({ error: "comment_not_found" });
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Math.min(50, Math.max(1, Number.isInteger(rawLimit) ? rawLimit : 50));
    const rawOffset = parseInt(req.query.offset, 10);
    const offset = Math.max(0, Number.isInteger(rawOffset) ? rawOffset : 0);
    const newest = String(req.query.sort || "").toLowerCase() === "newest";
    const children = data.comments
      .filter((x) => x.parentCommentId === id)
      .sort((a, b) => (newest ? b.ts - a.ts : a.ts - b.ts));
    const total = children.length;
    const page = children.slice(offset, offset + limit);
    const viewerKey = "ip:" + (req.ip || "unknown");
    page.forEach((x) => recordCommentView(x.id, viewerKey));
    const stats = buildCommentStats();
    res.json({
      replies: page.map((x) => publicComment(x, stats)),
      total,
      limit,
      offset,
      hasMore: offset + page.length < total,
    });
  });

  // Comment reactions are first-class objects, separate from root-post reactions.
  app.post("/api/social/comments/reactions", (req, res) => {
    const { session, error, code } = authedSession(sessions, req.body && req.body.sessionId);
    if (error) return res.status(code).json({ error });
    const ids = Array.isArray(req.body.ids)
      ? req.body.ids.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0).slice(0, 100)
      : [];
    const address = session.address;
    res.json({
      likedIds: data.commentLikes.filter((r) => sameAddress(r.address, address) && ids.includes(r.commentId)).map((r) => r.commentId),
      repostedIds: data.commentReposts.filter((r) => sameAddress(r.address, address) && ids.includes(r.commentId)).map((r) => r.commentId),
      savedIds: data.commentSaves.filter((r) => sameAddress(r.address, address) && ids.includes(r.commentId)).map((r) => r.commentId),
    });
  });

  async function commentReaction(req, res, kind) {
    const { session, error, code } = authedSession(sessions, req.body && req.body.sessionId);
    if (error) return res.status(code).json({ error });
    const id = parseInt(req.params.id, 10);
    const comment = data.comments.find((x) => x.id === id);
    if (!comment) return res.status(404).json({ error: "comment_not_found" });
    if (comment.hidden || comment.deleted) return res.status(410).json({ error: "comment_unavailable" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const config = kind === "like"
      ? { key: "commentLikes", field: "liked", count: commentLikeCountOf }
      : kind === "repost"
        ? { key: "commentReposts", field: "reposted", count: commentRepostCountOf }
        : { key: "commentSaves", field: "saved", count: commentSaveCountOf };
    const rows = data[config.key];
    const idx = rows.findIndex((r) => r.commentId === id && sameAddress(r.address, session.address));
    let active;
    if (idx >= 0) { rows.splice(idx, 1); active = false; }
    else {
      const record = { commentId: id, address: session.address, handle, ts: Date.now() };
      if (kind === "repost") record.postId = comment.postId;
      rows.push(record); active = true;
    }
    await save();
    res.json({ [config.field]: active, [kind === "save" ? "saveCount" : kind + "Count"]: config.count(id) });
  }
  app.post("/api/social/comments/:id/like", (req, res) => commentReaction(req, res, "like"));
  app.post("/api/social/comments/:id/repost", (req, res) => commentReaction(req, res, "repost"));
  app.post("/api/social/comments/:id/save", (req, res) => commentReaction(req, res, "save"));

  // ---- Comment moderation (nested replies) ----
  app.post("/api/social/comments/:id/report", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const commentId = parseInt(req.params.id, 10);
    const c = data.comments.find((x) => x.id === commentId);
    if (!c) return res.status(404).json({ error: "comment_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const reason =
      typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    if (!COMMENT_REPORT_REASONS.includes(reason))
      return res.status(400).json({ error: "invalid_reason" });
    const details =
      typeof req.body.details === "string" ? req.body.details.trim() : "";
    if (details.length > MAX_REPORT_DETAILS)
      return res.status(400).json({ error: "invalid_details" });
    if (
      data.reports.some(
        (r) => r.commentId === commentId && r.reporter === session.address
      )
    )
      return res.status(409).json({ error: "duplicate_report" });
    const report = {
      id: crypto.randomBytes(8).toString("hex"),
      commentId,
      postId: c.postId,
      reporter: session.address,
      reporterHandle: handle,
      reason,
      details: details || null,
      ts: Date.now(),
    };
    data.reports.push(report);
    await save();
    res.json({ ok: true, reportId: report.id, status: "received" });
  });

  // Moderator hide/unhide/delete for a single comment (admin wallet
  // session only, via admin.js requireAdmin). Hide is reversible.
  // Delete is a soft delete with permanent text purge.
  app.post("/api/social/comments/:id/hide", async (req, res) => {
    const admin = adminAuth.requireAdmin(sessions, req, res);
    if (!admin) return;
    const commentId = parseInt(req.params.id, 10);
    const c = data.comments.find((x) => x.id === commentId);
    if (!c) return res.status(404).json({ error: "comment_not_found" });
    c.hidden = true;
    c.hiddenAt = Date.now();
    c.hiddenBy = admin.address;
    await save();
    res.json({ ok: true, comment: publicComment(c, buildCommentStats()) });
  });

  app.post("/api/social/comments/:id/unhide", async (req, res) => {
    const admin = adminAuth.requireAdmin(sessions, req, res);
    if (!admin) return;
    const commentId = parseInt(req.params.id, 10);
    const c = data.comments.find((x) => x.id === commentId);
    if (!c) return res.status(404).json({ error: "comment_not_found" });
    c.hidden = false;
    delete c.hiddenAt;
    delete c.hiddenBy;
    await save();
    res.json({ ok: true, comment: publicComment(c, buildCommentStats()) });
  });

  app.post("/api/social/comments/:id/delete", async (req, res) => {
    const admin = adminAuth.requireAdmin(sessions, req, res);
    if (!admin) return;
    const commentId = parseInt(req.params.id, 10);
    const c = data.comments.find((x) => x.id === commentId);
    if (!c) return res.status(404).json({ error: "comment_not_found" });
    c.deleted = true;
    c.text = ""; // original text purged permanently on save
    c.deletedAt = Date.now();
    c.deletedBy = admin.address;
    await save();
    res.json({ ok: true, comment: publicComment(c, buildCommentStats()) });
  });

  // ---- Search (ported from make.fun-era) ----
  // Tabs: posts (Top, engagement-ranked) | latest | people | media.
  app.get("/api/social/search", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const f = typeof req.query.f === "string" ? req.query.f : "posts";
    if (!q || q.length > 100) return res.status(400).json({ error: "invalid_query" });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const needle = q.toLowerCase();
    const stats = buildCommentStats();
    if (f === "people") {
      const seen = new Map();
      for (const [addr, handle] of Object.entries(data.handles)) {
        if (handle) seen.set(handle.toLowerCase(), { handle, address: addr });
      }
      for (const m of data.messages) {
        if (m.handle && m.room === "social") seen.set(m.handle.toLowerCase(), { handle: m.handle, address: m.address });
      }
      for (const c of data.comments) {
        if (c.handle) seen.set(c.handle.toLowerCase(), { handle: c.handle, address: c.address });
      }
      const matched = [...seen.values()].filter((p) => p.handle.toLowerCase().includes(needle));
      const people = matched.slice(offset, offset + limit).map((p) => ({
        handle: p.handle,
        address: p.address,
        avatarUrl: profiles.avatarUrlFor(p.handle),
        verified: bluetick.isVerifiedAddress(p.address),
        followersCount: data.follows.filter((fl) => fl.following.toLowerCase() === p.address.toLowerCase()).length,
      }));
      return res.json({ ok: true, type: "people", query: q, people, total: matched.length, hasMore: offset + limit < matched.length });
    }
    let posts = data.messages.filter((m) => m.room === "social" && typeof m.text === "string" && m.text.toLowerCase().includes(needle));
    if (f === "media") posts = posts.filter((m) => (m.images && m.images.length) || m.image);
    if (f === "latest") posts.sort((a, b) => b.ts - a.ts);
    else posts.sort((a, b) => (likeCountOf(b.id) + repostCountOf(b.id) + viewCountOf(b.id)) - (likeCountOf(a.id) + repostCountOf(a.id) + viewCountOf(a.id)) || b.ts - a.ts);
    const total = posts.length;
    const page = posts.slice(offset, offset + limit).map((m) => publicMsg(m, stats));
    res.json({ ok: true, type: f === "media" ? "media" : f === "latest" ? "latest" : "posts", query: q, posts: page, total, hasMore: offset + limit < total });
  });

  // ---- Trending (ported from make.fun-era) ----
  // Trending topics (hashtags) + trending posts by engagement + suggested accounts.
  app.get("/api/social/trending", (req, res) => {
    const stats = buildCommentStats();
    const tagCounts = new Map();
    const tagAuthors = new Map();
    const cutoff = Date.now() - 90 * 86400000;
    const texts = [];
    for (const m of data.messages) if (m.room === "social" && m.ts >= cutoff) texts.push({ text: m.text, handle: m.handle });
    for (const c of data.comments) if (c.ts >= cutoff && !c.hidden && !c.deleted) texts.push({ text: c.text, handle: c.handle });
    for (const { text, handle } of texts) {
      if (typeof text !== "string") continue;
      const tags = text.match(/#[\p{L}\p{N}_]+/gu) || [];
      for (const raw of tags) {
        const tag = raw.slice(1).toLowerCase();
        if (!tag) continue;
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        if (!tagAuthors.has(tag)) tagAuthors.set(tag, new Set());
        if (handle) tagAuthors.get(tag).add(handle);
      }
    }
    const topics = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([tag, count], i) => ({ rank: i + 1, tag: "#" + tag, count, authors: [...(tagAuthors.get(tag) || [])].slice(0, 2) }));
    const weekAgo = Date.now() - 7 * 86400000;
    let posts = data.messages.filter((m) => m.room === "social" && m.ts >= weekAgo);
    if (posts.length < 3) posts = data.messages.filter((m) => m.room === "social");
    const scored = posts.map((m) => ({ m, score: likeCountOf(m.id) + repostCountOf(m.id) * 2 + (stats.postTotals.get(m.id) || 0) + viewCountOf(m.id) }));
    scored.sort((a, b) => b.score - a.score || b.m.ts - a.m.ts);
    const topPosts = scored.slice(0, 10).map((x) => publicMsg(x.m, stats));
    // Suggested accounts to follow: top handles by follower count.
    const followerCounts = new Map();
    for (const fl of data.follows) followerCounts.set(fl.following.toLowerCase(), (followerCounts.get(fl.following.toLowerCase()) || 0) + 1);
    const seenHandles = new Map();
    for (const [addr, handle] of Object.entries(data.handles)) if (handle) seenHandles.set(addr.toLowerCase(), handle);
    for (const m of data.messages) if (m.handle) seenHandles.set(m.address.toLowerCase(), m.handle);
    const suggested = [...followerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([addr, count]) => {
        const handle = seenHandles.get(addr);
        if (!handle) return null;
        return { handle, address: addr, avatarUrl: profiles.avatarUrlFor(handle), verified: bluetick.isVerifiedAddress(addr), followersCount: count };
      })
      .filter(Boolean);
    res.json({ ok: true, topics, posts: topPosts, suggested });
  });

  // ---- Notifications (ported from make.fun-era, BAW auth) ----
  // Tabs: all | mentions (replies + @mentions).
  app.get("/api/social/notifications", async (req, res) => {
    const { session, error, code } = authedSession(sessions, req.query && req.query.sessionId);
    if (error) return res.status(code).json({ error });
    const me = session.address;
    const myHandle = (await resolveHandle(session.address) || "").toLowerCase();
    const tab = req.query.tab === "mentions" ? "mentions" : "all";
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const stats = buildCommentStats();
    const myPosts = new Map(data.messages.filter((m) => m.room === "social" && sameAddress(m.address, me)).map((m) => [m.id, m]));
    const myComments = new Map(data.comments.filter((c) => sameAddress(c.address, me)).map((c) => [c.id, c]));
    const handleByAddr = new Map();
    for (const [addr, handle] of Object.entries(data.handles)) if (handle) handleByAddr.set(addr.toLowerCase(), handle);
    for (const m of data.messages) if (m.handle) handleByAddr.set(m.address.toLowerCase(), m.handle);
    for (const c of data.comments) if (c.handle) handleByAddr.set(c.address.toLowerCase(), c.handle);
    const actorOf = (addr) => {
      const handle = handleByAddr.get(addr.toLowerCase()) || null;
      return { address: addr, handle, avatarUrl: handle ? profiles.avatarUrlFor(handle) : null, verified: handle ? bluetick.isVerifiedAddress(addr) : false };
    };
    const events = [];
    for (const fl of data.follows) {
      if (sameAddress(fl.following, me) && !sameAddress(fl.follower, me)) {
        events.push({ type: "follow", targetKind: "user", targetId: me, actorAddr: fl.follower, ts: fl.ts || 0 });
      }
    }
    for (const l of data.likes) {
      const post = myPosts.get(l.messageId);
      if (!post || sameAddress(l.address, me)) continue;
      events.push({ type: "like", targetKind: "post", targetId: l.messageId, postId: l.messageId, actorAddr: l.address, ts: l.ts || post.ts });
    }
    for (const l of data.commentLikes || []) {
      const c = myComments.get(l.commentId);
      if (!c || sameAddress(l.address, me)) continue;
      events.push({ type: "like", targetKind: "comment", targetId: l.commentId, postId: c.postId, commentId: l.commentId, actorAddr: l.address, ts: l.ts || c.ts });
    }
    for (const r of data.reposts) {
      const post = myPosts.get(r.messageId);
      if (!post || sameAddress(r.address, me)) continue;
      events.push({ type: "repost", targetKind: "post", targetId: r.messageId, postId: r.messageId, actorAddr: r.address, ts: r.ts || post.ts });
    }
    for (const r of data.commentReposts || []) {
      const c = myComments.get(r.commentId);
      if (!c || sameAddress(r.address, me)) continue;
      events.push({ type: "repost", targetKind: "comment", targetId: r.commentId, postId: c.postId, commentId: r.commentId, actorAddr: r.address, ts: r.ts || c.ts });
    }
    for (const c of data.comments) {
      if (sameAddress(c.address, me) || c.hidden || c.deleted) continue;
      if (c.parentCommentId == null) {
        if (myPosts.get(c.postId)) events.push({ type: "reply", targetKind: "post", targetId: c.postId, postId: c.postId, commentId: c.id, actorAddr: c.address, ts: c.ts });
      } else if (myComments.get(c.parentCommentId)) {
        events.push({ type: "reply", targetKind: "comment", targetId: c.parentCommentId, postId: c.postId, commentId: c.id, actorAddr: c.address, ts: c.ts });
      }
    }
    if (myHandle) {
      const re = new RegExp("@" + myHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9_])", "i");
      for (const m of data.messages) {
        if (m.room !== "social" || sameAddress(m.address, me)) continue;
        if (typeof m.text === "string" && re.test(m.text)) events.push({ type: "mention", targetKind: "post", targetId: m.id, postId: m.id, actorAddr: m.address, ts: m.ts });
      }
      for (const c of data.comments) {
        if (sameAddress(c.address, me) || c.hidden || c.deleted) continue;
        if (typeof c.text === "string" && re.test(c.text)) events.push({ type: "mention", targetKind: "comment", targetId: c.id, postId: c.postId, commentId: c.id, actorAddr: c.address, ts: c.ts });
      }
    }
    // A comment that is both a reply to me and an @mention of me shows once, as a reply.
    let list = events.filter((e) => {
      if (e.type !== "mention" || e.commentId == null) return true;
      return !events.some((x) => x.type === "reply" && x.commentId === e.commentId);
    });
    if (tab === "mentions") list = list.filter((e) => e.type === "reply" || e.type === "mention");
    list.sort((a, b) => b.ts - a.ts);
    const groups = new Map();
    const full = [];
    for (const e of list) {
      if (e.type === "reply" || e.type === "mention") { full.push(e); continue; }
      const key = e.type + ":" + e.targetKind + ":" + e.targetId;
      if (!groups.has(key)) groups.set(key, { ...e, actors: [], count: 0 });
      const g = groups.get(key);
      g.actors.push(e.actorAddr);
      g.count += 1;
      g.ts = Math.max(g.ts, e.ts);
    }
    const merged = [...groups.values(), ...full].sort((a, b) => b.ts - a.ts);
    const total = merged.length;
    const page = merged.slice(offset, offset + limit);
    const notifications = page.map((e) => {
      const addrs = e.actors ? [...new Set(e.actors)] : [e.actorAddr];
      const actors = addrs.slice(0, 2).map((a) => actorOf(a));
      let snippet = null, post = null, comment = null;
      if (e.targetKind === "post" && e.postId != null) {
        const m = data.messages.find((x) => x.id === e.postId);
        if (m) { post = publicMsg(m, stats); snippet = m.text; }
      }
      if (e.targetKind === "comment" && e.commentId != null) {
        const c = data.comments.find((x) => x.id === e.commentId);
        if (c) { comment = publicComment(c, stats); snippet = c.text; }
      }
      if (e.type === "reply" || e.type === "mention") {
        if (e.commentId != null) { const c = data.comments.find((x) => x.id === e.commentId); if (c) comment = publicComment(c, stats); }
        else if (e.postId != null) { const m = data.messages.find((x) => x.id === e.postId); if (m) post = publicMsg(m, stats); }
      }
      return { type: e.type, targetKind: e.targetKind, postId: e.postId || null, commentId: e.commentId || null, actors, count: e.count || 1, ts: e.ts, snippet: snippet ? String(snippet).slice(0, 200) : null, post, comment };
    });
    res.json({ ok: true, tab, notifications, total, hasMore: offset + limit < total });
  });
};
// resolveHandle is also used by profiles.js: the handle is resolved
// on-chain from the session address (Agent ID registry), so the
// session address alone proves handle ownership.
module.exports.resolveHandle = resolveHandle;
