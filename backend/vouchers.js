// Voucher store for agentics.forum Blue Tick (free OR discount).
// Owns vouchers.json (same file + shape as the v1 admin store, plus
// kind/discountPct/discountUsdt). v1 vouchers stored without a `kind`
// are treated as "free". Both admin.js (create/list/delete) and
// blue-tick.js (redeem + claim with voucherCode) use this module.
// Writes are serialized (tmp + rename, same pattern as blue-tick.js).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE =
  process.env.VOUCHERS_DATA || path.join(__dirname, "vouchers.json");
const USDT_DECIMALS = 18; // BSC-USD (USDT on BNB Smart Chain) uses 18 decimals
const BASE_PRICE_BI = 5000000000000000000n; // 5 USDT, 18 decimals
const BASE_PRICE = BASE_PRICE_BI.toString();
const CENT_UNIT_BI = 10000000000000000n; // 0.01 USDT in 18-decimal base units

let data = { vouchers: {} };
try {
  if (fs.existsSync(DATA_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (loaded && typeof loaded === "object" && loaded.vouchers)
      data = { vouchers: loaded.vouchers };
  }
} catch (e) {
  /* start fresh */
}
// Normalize v1 records (no kind) to "free" so every code path can rely
// on kind/discountPct/discountUsdt being present.
for (const v of Object.values(data.vouchers)) {
  if (!v || typeof v !== "object") continue;
  if (v.kind !== "free" && v.kind !== "discount") v.kind = "free";
  if (v.kind === "free") {
    v.discountPct = null;
    v.discountUsdt = null;
  } else {
    if (v.discountPct === undefined) v.discountPct = null;
    if (v.discountUsdt === undefined) v.discountUsdt = null;
  }
  if (!Array.isArray(v.usedBy)) v.usedBy = [];
  if (!Number.isInteger(v.usedCount)) v.usedCount = 0;
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

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 8; i++)
      code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (data.vouchers[code]);
  return code;
}

function kindOf(voucher) {
  if (!voucher) return "free";
  return voucher.kind === "discount" ? "discount" : "free";
}

// Discounted price in 18-decimal base units (exact decimal string), or null
// for a free voucher. Uses BigInt so 18-decimal BSC USDT values never lose
// JS Number precision. Result must be > 0.
function discountedPrice(voucher) {
  if (!voucher || kindOf(voucher) !== "discount") return null;
  let price = null;
  if (voucher.discountPct !== null && voucher.discountPct !== undefined) {
    price = (BASE_PRICE_BI * BigInt(100 - voucher.discountPct)) / 100n;
  } else if (
    voucher.discountUsdt !== null &&
    voucher.discountUsdt !== undefined
  ) {
    const cents = BigInt(Math.round(voucher.discountUsdt * 100));
    price = BASE_PRICE_BI - cents * CENT_UNIT_BI;
  }
  if (price === null || price <= 0n) return null;
  return price.toString();
}

function baseUnitsToUsdt(units) {
  if (units === null || units === undefined) return 0;
  const bi = BigInt(String(units));
  const cents = bi / CENT_UNIT_BI;
  return Number(cents) / 100;
}

function formatUsdt(v) {
  // Stored values have at most 2 decimals; print without float noise.
  return String(Math.round(v * 100) / 100);
}

function discountLabel(voucher) {
  if (!voucher || kindOf(voucher) !== "discount") return "FREE";
  if (voucher.discountPct !== null && voucher.discountPct !== undefined)
    return voucher.discountPct + "% OFF";
  if (voucher.discountUsdt !== null && voucher.discountUsdt !== undefined)
    return formatUsdt(voucher.discountUsdt) + " USDT OFF";
  return "FREE";
}

function invalid(msg) {
  const err = new Error(msg);
  err.code = "invalid_input";
  return err;
}

async function createVoucher(input) {
  const body = input || {};
  // kind (default "free" when omitted, so v1 callers keep working)
  let kind = "free";
  if (body.kind !== undefined && body.kind !== null && body.kind !== "") {
    kind = String(body.kind).trim().toLowerCase();
    if (kind !== "free" && kind !== "discount")
      throw invalid("kind must be free or discount");
  }
  // days
  const days = body.days === undefined ? 365 : Number(body.days);
  if (!Number.isInteger(days) || days <= 0 || days > 3650)
    throw invalid("days must be an integer 1-3650");
  // maxUses
  const maxUses = body.maxUses === undefined ? 1 : Number(body.maxUses);
  if (!Number.isInteger(maxUses) || maxUses <= 0 || maxUses > 1000)
    throw invalid("maxUses must be an integer 1-1000");
  // note
  let note = "";
  if (body.note !== undefined) {
    if (typeof body.note !== "string" || body.note.length > 200)
      throw invalid("note must be a string up to 200 chars");
    note = body.note;
  }
  // discount fields: for "free" both must be absent; for "discount"
  // exactly one must be set.
  const hasPct =
    body.discountPct !== undefined &&
    body.discountPct !== null &&
    body.discountPct !== "";
  const hasUsdt =
    body.discountUsdt !== undefined &&
    body.discountUsdt !== null &&
    body.discountUsdt !== "";
  let discountPct = null;
  let discountUsdt = null;
  if (kind === "free") {
    if (hasPct || hasUsdt) throw invalid("free vouchers take no discount");
  } else {
    if (hasPct && hasUsdt)
      throw invalid("set exactly one of discountPct / discountUsdt");
    if (!hasPct && !hasUsdt)
      throw invalid("discount vouchers need discountPct or discountUsdt");
    if (hasPct) {
      discountPct = Number(body.discountPct);
      if (
        !Number.isInteger(discountPct) ||
        discountPct < 1 ||
        discountPct > 99
      )
        throw invalid("discountPct must be an integer 1-99");
    } else {
      discountUsdt = Number(body.discountUsdt);
      if (
        !Number.isFinite(discountUsdt) ||
        discountUsdt <= 0 ||
        discountUsdt >= 5 ||
        Math.abs(discountUsdt * 100 - Math.round(discountUsdt * 100)) > 1e-9
      )
        throw invalid(
          "discountUsdt must be > 0 and < 5 with max 2 decimals"
        );
    }
  }
  // code
  let code;
  if (typeof body.code === "string" && body.code.trim() !== "") {
    code = body.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(code))
      throw invalid("code must be 4-16 chars A-Z0-9");
    if (data.vouchers[code]) {
      const err = new Error("code already exists");
      err.code = "duplicate_code";
      throw err;
    }
  } else {
    code = genCode();
  }
  const voucher = {
    code,
    kind,
    days,
    discountPct,
    discountUsdt,
    maxUses,
    usedCount: 0,
    usedBy: [],
    createdAt: Date.now(),
    note,
    active: true,
  };
  data.vouchers[code] = voucher;
  await save();
  return voucher;
}

function getVoucher(code) {
  const c = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!c) return null;
  return data.vouchers[c] || null;
}

function listVouchers() {
  return Object.values(data.vouchers).sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
  );
}

async function deactivateVoucher(code) {
  const v = getVoucher(code);
  if (!v) return false;
  v.active = false;
  await save();
  return true;
}

async function useVoucher(code, handle) {
  const v = getVoucher(code);
  if (!v || !v.active) return false;
  v.usedCount += 1;
  v.usedBy.push(String(handle || "").toLowerCase());
  await save();
  return true;
}

// Can this handle use this voucher? Precedence: invalid_code, then
// voucher_exhausted, then already_redeemed.
function canUse(voucher, handle) {
  if (!voucher || !voucher.active)
    return { ok: false, error: "invalid_code" };
  if (voucher.usedCount >= voucher.maxUses)
    return { ok: false, error: "voucher_exhausted" };
  const key = String(handle || "").toLowerCase();
  if ((voucher.usedBy || []).some((h) => String(h).toLowerCase() === key))
    return { ok: false, error: "already_redeemed" };
  return { ok: true };
}

module.exports = {
  createVoucher,
  getVoucher,
  listVouchers,
  deactivateVoucher,
  useVoucher,
  discountedPrice,
  baseUnitsToUsdt,
  discountLabel,
  canUse,
  kindOf,
  BASE_PRICE,
  BASE_PRICE_BI,
  USDT_DECIMALS,
  _data: data,
};
