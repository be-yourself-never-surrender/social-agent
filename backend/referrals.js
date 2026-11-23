// Referral ledger for agentics.forum: who referred whom, and whether the
// invitee's first paid mint has happened (the bonus gate).
// The auto-follow itself lives in social.js (it owns data.follows);
// this module owns only the referral records. First-applied referrer
// wins: a wallet's referrer is never overwritten by a later link.
const fs = require("fs");
const path = require("path");

const DATA_FILE =
  process.env.REFERRALS_DATA || path.join(__dirname, "referrals.json");

let data = { referrals: [] };
try {
  if (fs.existsSync(DATA_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    data = { ...data, ...loaded };
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

function same(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
function getReferral(referred) {
  return data.referrals.find((r) => same(r.referred, referred)) || null;
}
// Returns { record, created }. created=false when a referrer was already
// recorded for this wallet: the old record is returned untouched.
async function recordReferral(referred, referrer) {
  const existing = getReferral(referred);
  if (existing) return { record: existing, created: false };
  const record = { referred, referrer, ts: Date.now(), firstPaidMint: false };
  data.referrals.push(record);
  await save();
  return { record, created: true };
}
// Called when a referred wallet completes a paid mint. Returns true only
// the first time (the bonus gate: once per invitee, first paid mint).
async function markFirstPaidMint(referred) {
  const rec = getReferral(referred);
  if (!rec || rec.firstPaidMint) return false;
  rec.firstPaidMint = true;
  await save();
  return true;
}
function countSuccessful(referrer) {
  return data.referrals.filter(
    (r) => same(r.referrer, referrer) && r.firstPaidMint
  ).length;
}

module.exports = {
  getReferral,
  recordReferral,
  markFirstPaidMint,
  countSuccessful,
};
