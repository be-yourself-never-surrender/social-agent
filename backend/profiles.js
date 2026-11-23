// Profile photo (avatar), banner, and bio for agentics.forum.
// Storage: JSON file in the backend dir (not web-served), writes serialized.
// Identity is derived from the active EIP-712 / browser session and verified
// on-chain against the SPACE ID .ai Agent ID registry on BNB Smart Chain.
const fs = require("fs");
const path = require("path");
const photos = require("./photos");
const { activeSession } = require("./session-check");
function resolveHandle(address) {
  return require("./social").resolveHandle(address);
}

const DATA_FILE =
  process.env.PROFILES_DATA || path.join(__dirname, "profiles.json");

// handle (lowercase) -> { avatarUrl, bannerUrl, avatarPhotoId,
// bannerPhotoId, updatedAt }. URLs are null when unset.
const data = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (loaded && typeof loaded === "object") Object.assign(data, loaded);
  }
} catch (e) {
  /* start fresh */
}

let writeQueue = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(data);
  writeQueue = writeQueue
    .then(() => fs.promises.writeFile(DATA_FILE + ".tmp", snapshot))
    .then(() => fs.promises.rename(DATA_FILE + ".tmp", DATA_FILE))
    .catch(() => {});
  return writeQueue;
}

function keyOf(handle) {
  return String(handle || "").toLowerCase();
}
function _recFor(handle) {
  if (!handle) return null;
  return data[keyOf(handle)] || null;
}
function avatarUrlFor(handle) {
  const rec = _recFor(handle);
  return rec && rec.avatarUrl ? rec.avatarUrl : null;
}
function bannerUrlFor(handle) {
  const rec = _recFor(handle);
  return rec && rec.bannerUrl ? rec.bannerUrl : null;
}
function bioFor(handle) {
  const rec = _recFor(handle);
  return rec && typeof rec.bio === "string" && rec.bio.trim() ? rec.bio : null;
}
// Marker stored in a photo's usedBy while it is a profile photo.
// A post's marker is its message id; the two never overwrite each
// other (see setProfilePhoto / maybeReleasePhoto).
function profileMarker(handle) {
  return "profile:" + keyOf(handle);
}
function isReferenced(photoId) {
  for (const rec of Object.values(data)) {
    if (!rec) continue;
    if (rec.avatarPhotoId === photoId || rec.bannerPhotoId === photoId)
      return true;
  }
  return false;
}
// Clear a photo's profile marker once nothing references it anymore.
// Only our own marker is ever cleared; a post's message-id marker is
// never touched, so a photo shared with a post stays protected.
async function maybeReleasePhoto(photoId, handle) {
  if (!photoId) return;
  if (isReferenced(photoId)) return;
  const p = photos.getPhoto(photoId);
  if (!p) return;
  if (p.usedBy !== profileMarker(handle)) return;
  await photos.markUsed(photoId, null);
}

function sameAddress(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase()
  );
}

async function setProfilePhoto(sessions, req, res, kind) {
  try {
    const { session, error, code } = activeSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    // The handle is resolved on-chain from the session address; only
    // a wallet with a verified .ai Agent ID has one.
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const key = keyOf(handle);
    const photoId =
      req.body && typeof req.body.photoId === "string"
        ? req.body.photoId.trim()
        : "";
    if (!photoId) return res.status(400).json({ error: "invalid_input" });
    const photo = photos.getPhoto(photoId);
    if (!photo) return res.status(404).json({ error: "photo_not_found" });
    if (!sameAddress(photo.owner, session.address))
      return res.status(403).json({ error: "photo_not_yours" });
    const rec = data[key] || (data[key] = {
      avatarUrl: null,
      bannerUrl: null,
      avatarPhotoId: null,
      bannerPhotoId: null,
      updatedAt: 0,
    });
    const oldPhotoId =
      kind === "avatar" ? rec.avatarPhotoId : rec.bannerPhotoId;
    const now = Date.now();
    if (kind === "avatar") {
      rec.avatarUrl = photo.url;
      rec.avatarPhotoId = photo.id;
    } else {
      rec.bannerUrl = photo.url;
      rec.bannerPhotoId = photo.id;
    }
    rec.updatedAt = now;
    // Mark the photo as used so it cannot be deleted while it is an
    // avatar or banner. Only when it is currently unused: an existing
    // marker (a post's message id, or this profile's marker) already
    // protects it and must not be overwritten.
    if (!photo.usedBy) await photos.markUsed(photo.id, profileMarker(key));
    await save();
    if (oldPhotoId && oldPhotoId !== photo.id)
      await maybeReleasePhoto(oldPhotoId, key);
    if (kind === "avatar")
      return res.json({ ok: true, handle: key, avatarUrl: photo.url });
    return res.json({ ok: true, handle: key, bannerUrl: photo.url });
  } catch (e) {
    return res.status(500).json({ error: "internal" });
  }
}

async function removeProfilePhoto(sessions, req, res, kind) {
  try {
    const { session, error, code } = activeSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const key = keyOf(handle);
    const rec = data[key];
    const oldPhotoId = rec
      ? kind === "avatar"
        ? rec.avatarPhotoId
        : rec.bannerPhotoId
      : null;
    if (rec) {
      if (kind === "avatar") {
        rec.avatarUrl = null;
        rec.avatarPhotoId = null;
      } else {
        rec.bannerUrl = null;
        rec.bannerPhotoId = null;
      }
      rec.updatedAt = Date.now();
      await save();
    }
    if (oldPhotoId) await maybeReleasePhoto(oldPhotoId, key);
    return res.json({ ok: true, handle: key });
  } catch (e) {
    return res.status(500).json({ error: "internal" });
  }
}

async function setProfileBio(sessions, req, res) {
  try {
    const { session, error, code } = activeSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const raw = req.body && typeof req.body.bio === "string" ? req.body.bio : null;
    if (raw === null) return res.status(400).json({ error: "invalid_input" });
    const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
    if (cleaned.length > 160)
      return res.status(400).json({ error: "bio_too_long", max: 160 });
    const key = keyOf(handle);
    const rec = data[key] || (data[key] = {
      avatarUrl: null,
      bannerUrl: null,
      avatarPhotoId: null,
      bannerPhotoId: null,
      bio: null,
      updatedAt: 0,
    });
    rec.bio = cleaned || null;
    rec.updatedAt = Date.now();
    await save();
    return res.json({ ok: true, handle: key, bio: rec.bio });
  } catch (e) {
    return res.status(500).json({ error: "internal" });
  }
}

function registerProfiles(app, sessions) {
  app.post("/api/social/profile/avatar", (req, res) =>
    setProfilePhoto(sessions, req, res, "avatar")
  );
  app.post("/api/social/profile/banner", (req, res) =>
    setProfilePhoto(sessions, req, res, "banner")
  );
  app.post("/api/social/profile/avatar/remove", (req, res) =>
    removeProfilePhoto(sessions, req, res, "avatar")
  );
  app.post("/api/social/profile/banner/remove", (req, res) =>
    removeProfilePhoto(sessions, req, res, "banner")
  );
  app.post("/api/social/profile/bio", (req, res) =>
    setProfileBio(sessions, req, res)
  );
}

module.exports = registerProfiles;
registerProfiles.avatarUrlFor = avatarUrlFor;
registerProfiles.bannerUrlFor = bannerUrlFor;
registerProfiles.bioFor = bioFor;
registerProfiles.isPhotoReferenced = isReferenced;
registerProfiles._store = data;
