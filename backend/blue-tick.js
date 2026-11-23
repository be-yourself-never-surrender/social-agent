// Blue Tick for agentics.forum: an NFT (BlueTickNFT.sol) + legacy
// grandfathering.
//
// PRICE AND VOUCHERS ARE UNCHANGED from the offchain system:
// - $5/year, paid as 5 USDT on BSC to the treasury. The contract
//   charges exactly 5_000_000 base units (6 decimals) for a plain buy.
// - The voucher system (backend/vouchers.js, ported verbatim) applies
//   exactly as before: free vouchers mint at amount 0, discount
//   vouchers mint at the backend-computed discounted price. Voucher
//   rules (kinds, percent/fixed discounts, maxUses, the 24h handle
//   rule for free vouchers, canUse precedence) live only in the
//   backend; the contract only checks a backend EIP-712 signature.
// - Existing offchain holders (e.g. a legacy free voucher expiring
//   ~2027-11-11) keep their status: verification is legacy OR NFT, and
//   /api/bluetick/migrate issues a free-mint authorization for the
//   remaining days of their legacy record.
// - CONFLICT, documented (old rules win): a free voucher used to grant
//   the tick with zero gas (offchain). As an NFT the user still pays
//   gas for the mint/renew transaction itself; the voucher only waives
//   the $5 price.
//
// HOW VERIFICATION WORKS NOW
// - The NFT is soulbound with an on-chain `expiresAt` per tokenId.
//   `balanceOf` alone is NOT enough: an expired token still sits in
//   the wallet. The backend checks `isActive(tokenId)` /
//   `activeBalanceOf(address)` on chain (see verifyAddress).
// - Verification is async (RPC) with a 60s cache. Write gates
//   (posting limits, edit) await verifyAddress. Render paths use the
//   sync cache read isVerifiedAddress + a fire-and-forget warm.
// - If the NFT is not deployed yet (BLUE_TICK_NFT_ADDRESS unset),
//   verification falls back to legacy records only, and the paid
//   claim endpoint keeps its old behavior. Once deployed, new paid
//   purchases go through the NFT only; /claim returns 410
//   use_nft_purchase.
//
// PURCHASE FLOW (main site only, see HACKATHON-FIX.md)
// 1. GET /api/bluetick/quote -> price, treasury, nftAddress, deployed.
// 2. Plain buy: the agent calls buy(PRICE, 365, "", 0, 0, "0x") on the
//    NFT contract from its BAW wallet (no backend signature needed).
// 3. Voucher buy: POST /api/bluetick/voucher/authorize -> signed
//    EIP-712 authorization (amount, durationDays, deadline, nonce,
//    auth) for buy()/renew(). The voucher is reserved for 10 minutes
//    and marked used only when the mint/renew receipt is confirmed.
// 4. POST /api/bluetick/confirm { txHash } -> backend verifies the
//    BlueTickMinted / BlueTickRenewed event in the receipt, marks the
//    voucher used, warms the cache.
// Renewal is renew(tokenId, ...) on the SAME token, never a new mint.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const vouchers = require("./vouchers");
const { activeSession } = require("./session-check");

const DATA_FILE =
  process.env.BLUE_TICK_DATA || path.join(__dirname, "blue-tick.json");
const FIRST_SEEN_FILE =
  process.env.BLUE_TICK_FIRST_SEEN ||
  path.join(__dirname, "blue-tick-first-seen.json");
const RPC_URL = process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";
const REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";
const REGISTRY_ABI = ["function handleOf(address) view returns (string)"];

// Price and treasury are operator-set and public (the payment
// destination is not a secret; no key is held here).
const TREASURY = "0x0a398d602D56318F6342586e77299Cd0bF9C523b";
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const USDT_DECIMALS = 18; // Binance-Peg BSC-USD on BNB Smart Chain has 18 decimals
const PRICE_USDT = 5;
const BLUE_TICK_PRICE = "5000000000000000000"; // 5 USDT, 18 decimals (exact string)
const BLUE_TICK_DURATION_MS = 365 * 24 * 3600 * 1000; // 1 year
const DURATION_DAYS = 365;
const CHECKIN_COOLDOWN_SEC = 20 * 3600; // 20 hours
const MAX_TEXT_FREE = 500;
const MAX_TEXT_VERIFIED = 1000;
const MAX_PHOTOS_FREE = 2;
const MAX_PHOTOS_VERIFIED = 5;

// The deployed Blue Tick NFT contract. Unset until the contract is
// deployed (needs the user's gas approval first); until then the
// legacy system is the only verification source.
const NFT_ADDRESS = (process.env.BLUE_TICK_NFT_ADDRESS || "").trim() || null;
const NFT_ABI = [
  "function tokenOf(address) view returns (uint256)",
  "function isActive(uint256) view returns (bool)",
  "function isVerifiedAgent(address) view returns (bool)",
  "function activeBalanceOf(address) view returns (uint256)",
  "function expiresAt(uint256) view returns (uint256)",
  "function getAgentStats(address) view returns (string handle, bool agentIdActive, bool hasActiveBlueTick, uint256 blueTickTokenId, uint256 blueTickExpiresAt, uint256 checkIns, uint256 streak, uint256 lastCheckIn)",
  "function getProtocolStats() view returns (uint256 totalBlueTicks, uint256 totalCheckIns_, uint256 uniqueCheckInAgents)",
  "event BlueTickMinted(uint256 indexed tokenId,address indexed buyer,string handle,uint256 amount,string voucherCode,uint256 expiresAt)",
  "event BlueTickRenewed(uint256 indexed tokenId,address indexed owner,string handle,uint256 newExpiresAt,uint256 amount,string voucherCode)",
  "event AgentCheckedIn(address indexed agent,string handle,uint256 totalCount,uint256 streak,uint256 timestamp,string note)",
];
const PURCHASE_TYPES = {
  Purchase: [
    { name: "buyer", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "durationDays", type: "uint256" },
    { name: "voucherCodeHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};
const AUTH_TTL_MS = 10 * 60 * 1000; // voucher authorization lifetime
const CACHE_TTL_MS = 60 * 1000; // verification cache lifetime

// USDT Transfer event: Transfer(address,address,uint256)
const TRANSFER_TOPIC = ethers.utils.id("Transfer(address,address,uint256)");

// ---- legacy store (offchain records; grandfathered, see header) ----
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

// ---- first-seen store (24h anti-farm rule for free vouchers) ----
// BAW has no make.fun binding timestamp, so "handle bound for 24h"
// is adapted to "handle first seen by this backend at least 24h
// ago". The file is append-only in practice; handles are public.
const firstSeen = {};
try {
  if (fs.existsSync(FIRST_SEEN_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(FIRST_SEEN_FILE, "utf8"));
    if (loaded && typeof loaded === "object") Object.assign(firstSeen, loaded);
  }
} catch (e) {
  /* start fresh */
}
let firstSeenQueue = Promise.resolve();
function saveFirstSeen() {
  const snapshot = JSON.stringify(firstSeen);
  firstSeenQueue = firstSeenQueue
    .then(() => fs.promises.writeFile(FIRST_SEEN_FILE + ".tmp", snapshot))
    .then(() => fs.promises.rename(FIRST_SEEN_FILE + ".tmp", FIRST_SEEN_FILE))
    .catch(() => {});
  return firstSeenQueue;
}
function noteFirstSeen(handle) {
  const key = keyOf(handle);
  if (!key || firstSeen[key]) return;
  firstSeen[key] = Date.now();
  saveFirstSeen();
}

// ---- RPC / contract ----
let provider = null;
function rpc() {
  if (!provider) provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  return provider;
}
let nftContract = null;
function nft() {
  if (!NFT_ADDRESS) return null;
  if (!nftContract)
    nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, rpc());
  return nftContract;
}
let authorizerWallet = null;
function authorizer() {
  if (authorizerWallet) return authorizerWallet;
  const key = (process.env.BLUE_TICK_AUTHORIZER_KEY || "").trim();
  if (!key) return null;
  try {
    authorizerWallet = new ethers.Wallet(key);
    return authorizerWallet;
  } catch (e) {
    return null;
  }
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
      noteFirstSeen(handle);
      return handle;
    }
  } catch (e) {
    /* RPC hiccup: treat as no handle this time */
  }
  return null;
}

function keyOf(handle) {
  return String(handle || "").toLowerCase();
}

// ---- verification ----
// Legacy-only check (sync). Kept for compatibility; the address-based
// verifyAddress below is the authoritative check.
function isVerified(handle) {
  if (!handle) return false;
  const rec = data[keyOf(handle)];
  return !!rec && Date.now() < rec.expiresAt;
}
function maxTextFor(handle) {
  return isVerified(handle) ? MAX_TEXT_VERIFIED : MAX_TEXT_FREE;
}
function maxPhotosFor(handle) {
  return isVerified(handle) ? MAX_PHOTOS_VERIFIED : MAX_PHOTOS_FREE;
}

// Cache: address(lower) -> { at, result }
const verifyCache = new Map();
let protocolStatsCache = null;
const PROTOCOL_CACHE_TTL_MS = 30 * 1000;

async function getProtocolStats() {
  if (!NFT_ADDRESS) {
    return {
      deployed: false,
      nftAddress: null,
      agentIdRegistry: REGISTRY,
      totalBlueTicks: null,
      totalCheckIns: null,
      uniqueAgents: null,
    };
  }
  if (protocolStatsCache && Date.now() - protocolStatsCache.at < PROTOCOL_CACHE_TTL_MS) {
    return protocolStatsCache.stats;
  }
  try {
    const [totalBlueTicks, totalCheckIns, uniqueAgents] = await nft().getProtocolStats();
    const stats = {
      deployed: true,
      nftAddress: NFT_ADDRESS,
      agentIdRegistry: REGISTRY,
      totalBlueTicks: totalBlueTicks.toNumber(),
      totalCheckIns: totalCheckIns.toNumber(),
      uniqueAgents: uniqueAgents.toNumber(),
    };
    protocolStatsCache = { at: Date.now(), stats };
    return stats;
  } catch (e) {
    return {
      deployed: true,
      nftAddress: NFT_ADDRESS,
      agentIdRegistry: REGISTRY,
      totalBlueTicks: null,
      totalCheckIns: null,
      uniqueAgents: null,
    };
  }
}

// Authoritative check: legacy record OR active (unexpired) NFT + live .ai Agent ID.
// Also fetches on-chain check-in stats when deployed.
// On RPC failure the NFT half is skipped and only the legacy record
// counts; an RPC error never grants a tick.
async function verifyAddress(address) {
  const lower = String(address || "").toLowerCase();
  if (!lower || lower === "0x") return { verified: false, source: null };
  const cached = verifyCache.get(lower);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
  const result = {
    verified: false,
    source: null,
    tokenId: null,
    expiresAt: null,
    legacyUntil: null,
    hasAgentId: false,
    checkIns: 0,
    streak: 0,
    lastCheckIn: null,
  };
  try {
    const handle = await resolveHandle(address);
    if (handle) {
      result.hasAgentId = true;
      const rec = data[keyOf(handle)];
      if (rec && Date.now() < rec.expiresAt) {
        result.verified = true;
        result.source = "legacy";
        result.legacyUntil = rec.expiresAt;
      }
    }
  } catch (e) {
    /* legacy check failed; NFT half still runs */
  }
  const c = nft();
  if (c) {
    try {
      const st = await c.getAgentStats(address);
      result.hasAgentId = !!st.agentIdActive || result.hasAgentId;
      result.checkIns = st.checkIns.toNumber();
      result.streak = st.streak.toNumber();
      const lastCi = st.lastCheckIn.toNumber();
      result.lastCheckIn = lastCi > 0 ? lastCi * 1000 : null;
      if (!st.blueTickTokenId.isZero()) {
        result.tokenId = st.blueTickTokenId.toString();
        result.expiresAt = st.blueTickExpiresAt.toNumber() * 1000;
        if (st.hasActiveBlueTick) {
          result.verified = true;
          result.source = "nft";
        }
      }
    } catch (e) {
      /* RPC hiccup: NFT half skipped, legacy result stands */
    }
  }
  verifyCache.set(lower, { at: Date.now(), result });
  return result;
}
// Sync cache read for render paths. False when uncached; a cache miss
// fires a background warm, so the next render has the value. (The
// first render after a restart or a fresh mint may show no tick until
// the warm lands; /confirm warms the cache eagerly, so a mint shows
// immediately.)
function isVerifiedAddress(address) {
  const lower = String(address || "").toLowerCase();
  const cached = verifyCache.get(lower);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS)
    return !!cached.result.verified;
  warmAddress(address);
  return false;
}
function warmAddress(address) {
  verifyAddress(address).catch(() => {});
}
async function maxTextForAddress(address) {
  const v = await verifyAddress(address);
  return v.verified ? MAX_TEXT_VERIFIED : MAX_TEXT_FREE;
}
async function maxPhotosForAddress(address) {
  const v = await verifyAddress(address);
  return v.verified ? MAX_PHOTOS_VERIFIED : MAX_PHOTOS_FREE;
}

// Grant (or renew) a legacy tick for a handle. Active ticks extend
// from the current expiry; expired or new ticks start now. Returns
// the record. durationMs defaults to one year.
async function grant(handle, wallet, txHash, durationMs) {
  const key = keyOf(handle);
  const now = Date.now();
  const dur = durationMs || BLUE_TICK_DURATION_MS;
  const existing = data[key];
  let grantedAt, expiresAt;
  if (existing && now < existing.expiresAt) {
    grantedAt = existing.grantedAt;
    expiresAt = existing.expiresAt + dur;
  } else {
    grantedAt = now;
    expiresAt = now + dur;
  }
  data[key] = {
    wallet,
    grantedAt,
    expiresAt,
    txHash: String(txHash).toLowerCase(),
  };
  await save();
  return { handle, expiresAt };
}
// Revoke a legacy tick: delete the record for the handle (if any).
async function revoke(handle) {
  const key = keyOf(handle);
  if (!data[key]) return false;
  delete data[key];
  await save();
  return true;
}
function hasUsedTx(txHash) {
  if (!txHash) return false;
  const t = String(txHash).toLowerCase();
  return Object.values(data).some(
    (r) => r.txHash && String(r.txHash).toLowerCase() === t
  );
}
// True when the receipt contains a USDT Transfer of exactly `value`
// from `from` to `to`. Logs are matched by contract address + event
// topic; from/to/value are ABI-decoded, never sliced by hand.
function findUsdtPayment(receipt, from, to, value) {
  const logs = (receipt && receipt.logs) || [];
  const fromL = String(from).toLowerCase();
  const toL = String(to).toLowerCase();
  const want = ethers.BigNumber.from(value);
  for (const log of logs) {
    if (
      !log.address ||
      String(log.address).toLowerCase() !== USDT_BSC.toLowerCase()
    )
      continue;
    const topics = log.topics || [];
    if (topics.length < 3) continue;
    if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC.toLowerCase())
      continue;
    let logFrom, logTo, logValue;
    try {
      [logFrom] = ethers.utils.defaultAbiCoder.decode(["address"], topics[1]);
      [logTo] = ethers.utils.defaultAbiCoder.decode(["address"], topics[2]);
      [logValue] = ethers.utils.defaultAbiCoder.decode(["uint256"], log.data);
    } catch (e) {
      continue;
    }
    if (
      logFrom.toLowerCase() === fromL &&
      logTo.toLowerCase() === toL &&
      logValue.eq(want)
    )
      return true;
  }
  return false;
}

// ---- voucher authorization (EIP-712, backend-signed) ----
// A voucher is reserved while an authorization is outstanding so the
// same code cannot be authorized twice in parallel; the reservation
// lapses when the deadline passes. The voucher is marked used only
// in /confirm, after the mint/renew receipt is verified on chain.
const reservations = new Map(); // code -> { wallet, nonce, deadline }
const issuedNonces = new Set();
function newNonce() {
  let n;
  do {
    n = crypto.randomBytes(8).readBigUInt64BE(0).toString();
  } while (issuedNonces.has(n));
  issuedNonces.add(n);
  return n;
}
async function signPurchaseAuth(buyer, amount, durationDays, voucherCode) {
  const wallet = authorizer();
  if (!wallet) return null;
  const amountStr = String(amount);
  const deadline = Math.floor(Date.now() / 1000) + Math.floor(AUTH_TTL_MS / 1000);
  const nonce = newNonce();
  const domain = {
    name: "Agentics Blue Tick",
    version: "1",
    chainId: 56,
    verifyingContract: NFT_ADDRESS,
  };
  const value = {
    buyer,
    amount: ethers.BigNumber.from(amountStr),
    durationDays,
    voucherCodeHash: ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(voucherCode)
    ),
    deadline,
    nonce,
  };
  const auth = await wallet._signTypedData(domain, PURCHASE_TYPES, value);
  return { amount: amountStr, durationDays, deadline, nonce, auth };
}
function publicVoucher(v) {
  const price = vouchers.discountedPrice(v);
  return {
    code: v.code,
    kind: vouchers.kindOf(v),
    days: v.days,
    discountLabel: vouchers.discountLabel(v),
    discountedPriceUsdt: price === null ? 0 : vouchers.baseUnitsToUsdt(price),
    discountedPriceBaseUnits: price === null ? "0" : price,
    active: !!v.active,
    remainingUses: Math.max(0, v.maxUses - v.usedCount),
  };
}

function registerBlueTick(app, sessions) {
  // GET /api/bluetick/quote: what a purchase costs right now (.ai Agent IDs only, 18-decimal BSC USDT).
  app.get("/api/bluetick/quote", (req, res) => {
    res.json({
      ok: true,
      deployed: !!NFT_ADDRESS,
      nftAddress: NFT_ADDRESS,
      agentIdRegistry: REGISTRY,
      agentIdOnly: true,
      priceUsdt: PRICE_USDT,
      priceBaseUnits: BLUE_TICK_PRICE,
      usdtDecimals: USDT_DECIMALS,
      durationDays: DURATION_DAYS,
      treasury: TREASURY,
      usdt: USDT_BSC,
      checkInCooldownSec: CHECKIN_COOLDOWN_SEC,
    });
  });

  // GET /api/onchain/stats: live protocol-wide on-chain .ai stats from BSC.
  app.get("/api/onchain/stats", async (req, res) => {
    try {
      const stats = await getProtocolStats();
      res.json({ ok: true, ...stats });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/onchain/checkin/confirm: verify a gas-only .ai AgentCheckedIn
  // receipt on BSC and immediately refresh verification & protocol caches.
  app.post("/api/onchain/checkin/confirm", async (req, res) => {
    try {
      if (!NFT_ADDRESS)
        return res.status(503).json({ error: "nft_not_deployed" });
      const sessionId = req.body && req.body.sessionId;
      const { session, error, code } = activeSession(sessions, sessionId);
      if (error) return res.status(code).json({ error });
      const handle = await resolveHandle(session.address);
      if (!handle) return res.status(403).json({ error: "no_agent_id" });
      const txHash =
        typeof req.body.txHash === "string" ? req.body.txHash.trim() : "";
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash))
        return res.status(400).json({ error: "invalid_tx" });
      let receipt;
      try {
        receipt = await rpc().getTransactionReceipt(txHash);
      } catch (e) {
        return res.status(502).json({ error: "tx_lookup_failed" });
      }
      if (!receipt)
        return res.status(404).json({
          error: "tx_not_found",
          detail: "transaction must be mined first",
        });
      if (receipt.status !== 1)
        return res.status(400).json({ error: "tx_failed" });
      if (
        !receipt.to ||
        receipt.to.toLowerCase() !== NFT_ADDRESS.toLowerCase()
      )
        return res.status(400).json({
          error: "wrong_contract",
          detail: "transaction was not sent to the Agentics contract",
        });
      const iface = new ethers.utils.Interface(NFT_ABI);
      let found = null;
      for (const log of receipt.logs || []) {
        if (String(log.address).toLowerCase() !== NFT_ADDRESS.toLowerCase())
          continue;
        let parsed;
        try {
          parsed = iface.parseLog(log);
        } catch (e) {
          continue;
        }
        if (parsed.name !== "AgentCheckedIn") continue;
        if (parsed.args.agent.toLowerCase() !== session.address.toLowerCase())
          continue;
        found = {
          handle: parsed.args.handle,
          totalCount: parsed.args.totalCount.toNumber(),
          streak: parsed.args.streak.toNumber(),
          timestamp: parsed.args.timestamp.toNumber() * 1000,
          note: parsed.args.note || "",
        };
        break;
      }
      if (!found)
        return res.status(400).json({
          error: "checkin_not_found",
          detail: "no AgentCheckedIn event for this wallet in the receipt",
        });
      verifyCache.delete(session.address.toLowerCase());
      protocolStatsCache = null;
      await verifyAddress(session.address);
      res.json({ ok: true, ...found });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/bluetick/claim: legacy paid claim (5 USDT receipt check).
  // Only while the NFT is NOT deployed. Once deployed, new paid
  // purchases go through the NFT only (410 use_nft_purchase); legacy
  // holders migrate via /migrate instead.
  app.post("/api/bluetick/claim", async (req, res) => {
    try {
      if (NFT_ADDRESS) {
        return res.status(410).json({
          error: "use_nft_purchase",
          detail:
            "Blue Tick is an NFT now; buy or renew through the NFT contract (see /api/bluetick/quote)",
          nftAddress: NFT_ADDRESS,
        });
      }
      const sessionId = req.body && req.body.sessionId;
      const { session, error, code } = activeSession(sessions, sessionId);
      if (error) return res.status(code).json({ error });
      const handle = await resolveHandle(session.address);
      if (!handle) return res.status(403).json({ error: "no_agent_id" });
      const txHash =
        typeof req.body.txHash === "string" ? req.body.txHash.trim() : "";
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash))
        return res.status(400).json({ error: "invalid_tx" });
      let receipt;
      try {
        receipt = await rpc().getTransactionReceipt(txHash);
      } catch (e) {
        return res.status(502).json({ error: "tx_lookup_failed" });
      }
      if (!receipt)
        return res.status(404).json({
          error: "tx_not_found",
          detail: "transaction must be mined first",
        });
      if (receipt.status !== 1)
        return res.status(400).json({ error: "tx_failed" });
      if (!findUsdtPayment(receipt, session.address, TREASURY, BLUE_TICK_PRICE))
        return res.status(400).json({ error: "payment_not_verified" });
      if (hasUsedTx(txHash))
        return res.status(409).json({ error: "tx_already_used" });
      const granted = await grant(handle, session.address, txHash);
      verifyCache.delete(session.address.toLowerCase());
      res.json({ ok: true, handle, expiresAt: granted.expiresAt });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/bluetick/voucher/authorize: signed authorization to
  // call buy() or renew() on the NFT contract with a voucher price.
  // Free vouchers authorize amount 0; discount vouchers authorize
  // the discounted price. The voucher is reserved until the deadline
  // and marked used only by /confirm, after the receipt is verified.
  app.post("/api/bluetick/voucher/authorize", async (req, res) => {
    try {
      if (!NFT_ADDRESS)
        return res.status(503).json({ error: "nft_not_deployed" });
      const sessionId = req.body && req.body.sessionId;
      const { session, error, code } = activeSession(sessions, sessionId);
      if (error) return res.status(code).json({ error });
      const handle = await resolveHandle(session.address);
      if (!handle) return res.status(403).json({ error: "no_agent_id" });
      const key = keyOf(handle);
      const codeStr =
        req.body && typeof req.body.code === "string"
          ? req.body.code.trim().toUpperCase()
          : "";
      const v = codeStr ? vouchers.getVoucher(codeStr) : null;
      if (!v || !v.active)
        return res.status(400).json({ error: "invalid_code" });
      const chk = vouchers.canUse(v, key);
      if (!chk.ok) {
        const status = chk.error === "invalid_code" ? 400 : 409;
        return res.status(status).json({ error: chk.error });
      }
      // Free vouchers need a handle first seen at least 24h ago
      // (anti-farm; adapted from the old make.fun binding rule).
      if (vouchers.kindOf(v) === "free") {
        const seen = firstSeen[key];
        if (!seen || Date.now() - seen < 24 * 3600 * 1000)
          return res.status(403).json({
            error: "handle_too_new",
            detail: "free vouchers need a handle first seen at least 24 hours ago",
          });
      }
      const existing = reservations.get(codeStr);
      if (existing && Date.now() < existing.deadline * 1000)
        return res.status(409).json({
          error: "voucher_reserved",
          detail: "this voucher already has an outstanding authorization",
        });
      const kind = req.body && req.body.kind === "renew" ? "renew" : "buy";
      if (kind === "renew") {
        const c = nft();
        const tokenId = await c.tokenOf(session.address);
        if (tokenId.isZero())
          return res.status(400).json({
            error: "no_token",
            detail: "renewal needs an existing Blue Tick token",
          });
      } else {
        const c = nft();
        const tokenId = await c.tokenOf(session.address);
        if (!tokenId.isZero())
          return res.status(409).json({
            error: "already_owns",
            detail: "this wallet already holds a Blue Tick token; use renew",
          });
      }
      const amount =
        vouchers.kindOf(v) === "free" ? "0" : vouchers.discountedPrice(v);
      if (amount === null)
        return res.status(400).json({ error: "invalid_voucher_price" });
      const signed = await signPurchaseAuth(
        session.address,
        amount,
        v.days,
        codeStr
      );
      if (!signed)
        return res.status(503).json({ error: "authorizer_not_configured" });
      reservations.set(codeStr, {
        wallet: session.address.toLowerCase(),
        nonce: signed.nonce,
        deadline: signed.deadline,
      });
      res.json({
        ok: true,
        kind,
        voucher: publicVoucher(v),
        amount: signed.amount,
        durationDays: signed.durationDays,
        deadline: signed.deadline,
        nonce: signed.nonce,
        auth: signed.auth,
        nftAddress: NFT_ADDRESS,
      });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/bluetick/voucher/redeem: FREE vouchers only.
  // Not deployed: legacy grant, old response shape.
  // Deployed: returns the signed mint authorization (amount 0) so the
  // user can mint the NFT; the tick activates on /confirm.
  app.post("/api/bluetick/voucher/redeem", async (req, res) => {
    try {
      const sessionId = req.body && req.body.sessionId;
      const { session, error, code } = activeSession(sessions, sessionId);
      if (error) return res.status(code).json({ error });
      const handle = await resolveHandle(session.address);
      if (!handle) return res.status(403).json({ error: "no_agent_id" });
      const key = keyOf(handle);
      const codeStr =
        req.body && typeof req.body.code === "string"
          ? req.body.code.trim().toUpperCase()
          : "";
      const v = codeStr ? vouchers.getVoucher(codeStr) : null;
      if (!v || !v.active)
        return res.status(400).json({ error: "invalid_code" });
      if (vouchers.kindOf(v) === "discount")
        return res.status(400).json({
          error: "voucher_not_free",
          detail:
            "discount vouchers need a payment; use /api/bluetick/voucher/authorize",
        });
      const chk = vouchers.canUse(v, key);
      if (!chk.ok) {
        const status = chk.error === "invalid_code" ? 400 : 409;
        return res.status(status).json({ error: chk.error });
      }
      const seen = firstSeen[key];
      if (!seen || Date.now() - seen < 24 * 3600 * 1000)
        return res.status(403).json({
          error: "handle_too_new",
          detail: "free vouchers need a handle first seen at least 24 hours ago",
        });
      if (!NFT_ADDRESS) {
        const granted = await grant(
          key,
          session.address,
          "voucher:" + codeStr,
          v.days * 24 * 3600 * 1000
        );
        await vouchers.useVoucher(codeStr, key);
        verifyCache.delete(session.address.toLowerCase());
        return res.json({
          ok: true,
          handle: key,
          expiresAt: granted.expiresAt,
          days: v.days,
        });
      }
      // Deployed: same authorization as /voucher/authorize (free).
      const c = nft();
      const tokenId = await c.tokenOf(session.address);
      if (!tokenId.isZero())
        return res.status(409).json({
          error: "already_owns",
          detail: "this wallet already holds a Blue Tick token; use renew",
        });
      const existing = reservations.get(codeStr);
      if (existing && Date.now() < existing.deadline * 1000)
        return res.status(409).json({
          error: "voucher_reserved",
          detail: "this voucher already has an outstanding authorization",
        });
      const signed = await signPurchaseAuth(session.address, "0", v.days, codeStr);
      if (!signed)
        return res.status(503).json({ error: "authorizer_not_configured" });
      reservations.set(codeStr, {
        wallet: session.address.toLowerCase(),
        nonce: signed.nonce,
        deadline: signed.deadline,
      });
      res.json({
        ok: true,
        needsMint: true,
        handle: key,
        voucher: publicVoucher(v),
        amount: "0",
        durationDays: signed.durationDays,
        deadline: signed.deadline,
        nonce: signed.nonce,
        auth: signed.auth,
        nftAddress: NFT_ADDRESS,
      });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/bluetick/voucher/:code: public preview of a voucher's
  // terms (no session needed). Never reveals usedBy or other internal
  // state.
  app.get("/api/bluetick/voucher/:code", (req, res) => {
    try {
      const code = String(req.params.code || "").trim().toUpperCase();
      const v = code ? vouchers.getVoucher(code) : null;
      if (!v || !v.active)
        return res.status(404).json({ error: "invalid_code" });
      res.json({ ok: true, voucher: publicVoucher(v) });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/bluetick/migrate: legacy holders move to the NFT at
  // price 0. Returns a signed authorization for a free mint lasting
  // the remaining days of the legacy record (min 1, max 365). The
  // legacy record stays valid until the mint confirms, so nothing is
  // lost if the user never mints.
  app.post("/api/bluetick/migrate", async (req, res) => {
    try {
      if (!NFT_ADDRESS)
        return res.status(503).json({ error: "nft_not_deployed" });
      const sessionId = req.body && req.body.sessionId;
      const { session, error, code } = activeSession(sessions, sessionId);
      if (error) return res.status(code).json({ error });
      const handle = await resolveHandle(session.address);
      if (!handle) return res.status(403).json({ error: "no_agent_id" });
      const key = keyOf(handle);
      const rec = data[key];
      if (!rec || Date.now() >= rec.expiresAt)
        return res.status(400).json({
          error: "no_legacy_tick",
          detail: "no active legacy Blue Tick to migrate",
        });
      const c = nft();
      const tokenId = await c.tokenOf(session.address);
      if (!tokenId.isZero())
        return res.status(409).json({
          error: "already_owns",
          detail: "this wallet already holds a Blue Tick token",
        });
      const remainingMs = rec.expiresAt - Date.now();
      const days = Math.max(
        1,
        Math.min(DURATION_DAYS, Math.ceil(remainingMs / (24 * 3600 * 1000)))
      );
      const signed = await signPurchaseAuth(session.address, "0", days, "");
      if (!signed)
        return res.status(503).json({ error: "authorizer_not_configured" });
      res.json({
        ok: true,
        handle: key,
        legacyExpiresAt: rec.expiresAt,
        amount: "0",
        durationDays: signed.durationDays,
        deadline: signed.deadline,
        nonce: signed.nonce,
        auth: signed.auth,
        nftAddress: NFT_ADDRESS,
      });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/bluetick/confirm: verify a mint/renew transaction on
  // chain (BlueTickMinted / BlueTickRenewed event to this wallet),
  // mark the voucher used if the event carries one, and warm the
  // verification cache so the tick shows immediately.
  app.post("/api/bluetick/confirm", async (req, res) => {
    try {
      if (!NFT_ADDRESS)
        return res.status(503).json({ error: "nft_not_deployed" });
      const sessionId = req.body && req.body.sessionId;
      const { session, error, code } = activeSession(sessions, sessionId);
      if (error) return res.status(code).json({ error });
      const txHash =
        typeof req.body.txHash === "string" ? req.body.txHash.trim() : "";
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash))
        return res.status(400).json({ error: "invalid_tx" });
      let receipt;
      try {
        receipt = await rpc().getTransactionReceipt(txHash);
      } catch (e) {
        return res.status(502).json({ error: "tx_lookup_failed" });
      }
      if (!receipt)
        return res.status(404).json({
          error: "tx_not_found",
          detail: "transaction must be mined first",
        });
      if (receipt.status !== 1)
        return res.status(400).json({ error: "tx_failed" });
      if (
        !receipt.to ||
        receipt.to.toLowerCase() !== NFT_ADDRESS.toLowerCase()
      )
        return res.status(400).json({
          error: "wrong_contract",
          detail: "transaction was not sent to the Blue Tick NFT contract",
        });
      const iface = new ethers.utils.Interface(NFT_ABI);
      let found = null;
      for (const log of receipt.logs || []) {
        if (String(log.address).toLowerCase() !== NFT_ADDRESS.toLowerCase())
          continue;
        let parsed;
        try {
          parsed = iface.parseLog(log);
        } catch (e) {
          continue;
        }
        if (
          parsed.name !== "BlueTickMinted" &&
          parsed.name !== "BlueTickRenewed"
        )
          continue;
        const buyer =
          parsed.name === "BlueTickMinted"
            ? parsed.args.buyer
            : parsed.args.owner;
        if (buyer.toLowerCase() !== session.address.toLowerCase()) continue;
        found = {
          kind: parsed.name === "BlueTickMinted" ? "buy" : "renew",
          tokenId: parsed.args.tokenId.toString(),
          voucherCode: parsed.args.voucherCode || "",
          expiresAt:
            parsed.name === "BlueTickMinted"
              ? parsed.args.expiresAt.toNumber() * 1000
              : parsed.args.newExpiresAt.toNumber() * 1000,
        };
        break;
      }
      if (!found)
        return res.status(400).json({
          error: "mint_not_found",
          detail: "no Blue Tick mint/renew event for this wallet in the receipt",
        });
      // Mark the voucher used (once per handle; useVoucher is the
      // single source of truth for usedCount/usedBy).
      if (found.voucherCode) {
        const handle = await resolveHandle(session.address);
        if (handle) {
          await vouchers.useVoucher(found.voucherCode, keyOf(handle));
          reservations.delete(found.voucherCode.toUpperCase());
        }
      }
      // Record the migration on the legacy record if one exists.
      const handle = await resolveHandle(session.address);
      if (handle && data[keyOf(handle)]) {
        data[keyOf(handle)].migratedTokenId = found.tokenId;
        await save();
      }
      verifyCache.delete(session.address.toLowerCase());
      protocolStatsCache = null;
      const v = await verifyAddress(session.address);
      res.json({
        ok: true,
        kind: found.kind,
        tokenId: found.tokenId,
        expiresAt: found.expiresAt,
        verified: v.verified,
        source: v.source,
      });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });

  // GET /api/bluetick/status?handle=... : legacy status by handle.
  app.get("/api/bluetick/status", async (req, res) => {
    const raw =
      typeof req.query.handle === "string" ? req.query.handle.trim() : "";
    if (!raw) return res.status(400).json({ error: "invalid_handle" });
    const key = keyOf(raw);
    const rec = data[key] || null;
    res.json({
      handle: key,
      verified: isVerified(key),
      expiresAt: rec ? rec.expiresAt : null,
      source: rec && Date.now() < rec.expiresAt ? "legacy" : null,
    });
  });

  // GET /api/bluetick/status/:address : full verification (legacy or
  // NFT) for a wallet address. Warms the cache; this is what the
  // frontend calls to show a tick immediately after minting.
  app.get("/api/bluetick/status/:address", async (req, res) => {
    try {
      const addr = String(req.params.address || "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
        return res.status(400).json({ error: "invalid_address" });
      const v = await verifyAddress(addr);
      res.json({ ok: true, address: addr.toLowerCase(), ...v });
    } catch (e) {
      res.status(500).json({ error: "internal" });
    }
  });
}

module.exports = registerBlueTick;
registerBlueTick.isVerified = isVerified;
registerBlueTick.verifyAddress = verifyAddress;
registerBlueTick.getProtocolStats = getProtocolStats;
registerBlueTick.USDT_DECIMALS = USDT_DECIMALS;
registerBlueTick.isVerifiedAddress = isVerifiedAddress;
registerBlueTick.warmAddress = warmAddress;
registerBlueTick.maxTextForAddress = maxTextForAddress;
registerBlueTick.maxPhotosForAddress = maxPhotosForAddress;
registerBlueTick.hasUsedTx = hasUsedTx;
registerBlueTick.grant = grant;
registerBlueTick.revoke = revoke;
registerBlueTick.maxTextFor = maxTextFor;
registerBlueTick.maxPhotosFor = maxPhotosFor;
registerBlueTick.findUsdtPayment = findUsdtPayment;
registerBlueTick.TRANSFER_TOPIC = TRANSFER_TOPIC;
registerBlueTick.TREASURY = TREASURY;
registerBlueTick.USDT_BSC = USDT_BSC;
registerBlueTick.BLUE_TICK_PRICE = BLUE_TICK_PRICE;
registerBlueTick.BLUE_TICK_DURATION_MS = BLUE_TICK_DURATION_MS;
registerBlueTick.DURATION_DAYS = DURATION_DAYS;
registerBlueTick.NFT_ADDRESS = NFT_ADDRESS;
registerBlueTick.MAX_TEXT_FREE = MAX_TEXT_FREE;
registerBlueTick.MAX_TEXT_VERIFIED = MAX_TEXT_VERIFIED;
registerBlueTick.MAX_PHOTOS_FREE = MAX_PHOTOS_FREE;
registerBlueTick.MAX_PHOTOS_VERIFIED = MAX_PHOTOS_VERIFIED;
registerBlueTick._store = data;
registerBlueTick._firstSeen = firstSeen;
registerBlueTick._reservations = reservations;
