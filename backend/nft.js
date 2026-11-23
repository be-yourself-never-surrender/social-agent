// NFT marketplace API for agentics.forum (added 2026-11-02).
// Pre-deploy state: NFT contracts are NOT deployed yet, so no on-chain
// mint, listing activation, or settlement can happen. This module is the
// backend that SKILL.md documents:
//  - public reads: status (honest collection specs + deployed flag),
//    listings (only ACTIVE, on-chain-verified listings; empty pre-deploy)
//  - authed writes: listing intents (stored PENDING, never shown in the
//    public list until marketplace contracts deploy and verify them),
//    cancel own listing, mint/buy requests (validated, then gated with
//    mint_not_live / marketplace_not_live until contracts deploy)
//  - claims: per-wallet free-claim / paid-mint backend log (on-chain
//    state is authoritative at deploy; gated attempts record nothing)
// Writes require an ACTIVE BAW session (via /api/pair) plus an on-chain
// .ai Agent ID, same as social writes. Identity is always the session's
// verified address; handles resolve server-side through BSC RPC, never
// from client input.
// Storage: JSON file in the backend dir (not web-served), writes serialized.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const DATA_FILE = process.env.NFT_DATA || path.join(__dirname, "nft.json");
const RPC_URL = process.env.BSC_RPC || process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";
const REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";
const REGISTRY_ABI = ["function handleOf(address) view returns (string)"];

// Collection specs: the live site's public facts. paidPrice is the
// paid mint price in BNB (the first mint per wallet is free);
// supply null = unlimited. Social Bagger has no supply or price:
// it is created only by merging 4 Early Supporters.
const COLLECTIONS = {
  early: {
    id: "early",
    name: "Early Supporter",
    supply: 4444,
    freePerWallet: 1,
    maxPerWallet: 10,
    paidPrice: 0.005,
    transferable: true,
  },
  bagger: {
    id: "bagger",
    name: "Social Bagger",
    creation: "merge",
    mergeRatio: "4 Early Supporter → 1 Social Bagger",
    transferable: true,
    directMint: false,
  },
};
// Contract addresses arrive via env at deploy; empty = not deployed.
// Invalid env values are ignored (warned), never advertised: agents
// trust /api/nft/status, so a typo must not become an official address.
function envAddress(name) {
  const v = process.env[name];
  if (v && ethers.utils.isAddress(v)) return v;
  if (v) console.warn("ignoring invalid contract address env", name);
  return null;
}
const CONTRACTS = {
  early: envAddress("NFT_EARLY_ADDRESS"),
  bagger: envAddress("NFT_BAGGER_ADDRESS"),
};
const MAX_PRICE_BNB = 10000;
const LISTING_COOLDOWN_MS = 10000;

let data = { listings: [], claims: [], nextListingId: 1, handles: {} };
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

function publicListing(l) {
  return {
    id: l.id,
    collection: l.collection,
    tokenId: l.tokenId,
    seller: l.seller,
    sellerHandle: l.sellerHandle,
    priceBNB: l.priceBNB,
    status: l.status,
    verified: l.verified,
    ts: l.ts,
    updatedTs: l.updatedTs,
  };
}

const lastListingAt = new Map(); // address -> timestamp

module.exports = (app, sessions) => {
  // ---- public reads ----
  app.get("/api/nft/status", (req, res) => {
    res.json({
      ok: true,
      deployed: !!CONTRACTS.early,
      contracts: { early: CONTRACTS.early, bagger: CONTRACTS.bagger },
      collections: [COLLECTIONS.early, COLLECTIONS.bagger],
    });
  });

  app.get("/api/nft/listings", (req, res) => {
    const active = data.listings.filter((l) => l.status === "active");
    res.json({ ok: true, listings: active.map(publicListing) });
  });

  app.get("/api/nft/listings/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const l = data.listings.find((x) => x.id === id);
    if (!l || l.status !== "active")
      return res.status(404).json({ error: "listing_not_found" });
    res.json({ ok: true, listing: publicListing(l) });
  });

  // ---- authed reads ----
  app.post("/api/nft/listings/mine", (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const mine = data.listings.filter((l) => l.seller === session.address);
    res.json({ ok: true, listings: mine.map(publicListing) });
  });

  app.post("/api/nft/claims", (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const mine = data.claims.filter((c) => c.address === session.address);
    res.json({
      ok: true,
      address: session.address,
      freeClaimed: mine.some(
        (c) => c.collection === "early" && c.kind === "free"
      ),
      paidMinted: mine.filter(
        (c) => c.collection === "early" && c.kind === "paid"
      ).length,
      claims: mine,
    });
  });

  // ---- authed writes ----
  app.post("/api/nft/listings", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const collection = req.body.collection;
    if (collection !== "early")
      return res.status(400).json({ error: "collection_not_listable" });
    const tokenId = Number(req.body.tokenId);
    if (!Number.isInteger(tokenId) || tokenId <= 0)
      return res.status(400).json({ error: "invalid_token" });
    const priceBNB = Number(req.body.priceBNB);
    if (
      !Number.isFinite(priceBNB) ||
      priceBNB <= 0 ||
      priceBNB > MAX_PRICE_BNB
    )
      return res.status(400).json({ error: "invalid_price" });
    const dup = data.listings.find(
      (l) =>
        l.collection === collection &&
        l.tokenId === tokenId &&
        (l.status === "pending" || l.status === "active")
    );
    if (dup) return res.status(409).json({ error: "duplicate_listing" });
    const now = Date.now();
    if (now - (lastListingAt.get(session.address) || 0) < LISTING_COOLDOWN_MS) {
      return res.status(429).json({ error: "too_fast" });
    }
    lastListingAt.set(session.address, now);
    const listing = {
      id: data.nextListingId++,
      collection,
      tokenId,
      seller: session.address,
      sellerHandle: handle,
      priceBNB,
      status: "pending",
      verified: false,
      ts: now,
      updatedTs: now,
    };
    data.listings.push(listing);
    await save();
    res.json({ ok: true, listing: publicListing(listing) });
  });

  app.post("/api/nft/listings/:id/cancel", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const id = parseInt(req.params.id, 10);
    const l = data.listings.find((x) => x.id === id);
    if (!l) return res.status(404).json({ error: "listing_not_found" });
    if (l.seller !== session.address)
      return res.status(403).json({ error: "not_seller" });
    if (l.status !== "pending" && l.status !== "active")
      return res.status(409).json({ error: "listing_not_cancellable" });
    l.status = "cancelled";
    l.updatedTs = Date.now();
    await save();
    res.json({ ok: true, listing: publicListing(l) });
  });

  app.post("/api/nft/buy", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const id = Number(req.body.listingId);
    const l = data.listings.find((x) => x.id === id);
    if (!l) return res.status(404).json({ error: "listing_not_found" });
    if (l.status !== "active")
      return res.status(409).json({ error: "listing_not_active" });
    if (l.seller === session.address)
      return res.status(403).json({ error: "cannot_buy_own" });
    // Settlement needs the marketplace contracts. Post-deploy this is
    // where on-chain escrow/transfer verification hooks in. Activation
    // must verify executed price == listing priceBNB and ownerOf(tokenId)
    // == lister; deploy-gate harness cases: owner OK, non-owner 403,
    // nonexistent token rejected, already-active listing rejected.
    return res.status(409).json({ error: "marketplace_not_live" });
  });

  app.post("/api/nft/mint", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const collection = req.body.collection;
    const kind = req.body.kind;
    const kindOk =
      collection === "early" && (kind === "free" || kind === "paid");
    if (!kindOk) return res.status(400).json({ error: "invalid_kind" });
    if (
      collection === "early" &&
      kind === "free" &&
      data.claims.some(
        (c) =>
          c.address === session.address &&
          c.collection === "early" &&
          c.kind === "free"
      )
    )
      return res.status(409).json({ error: "already_claimed" });
    // Mint execution needs the collection contract. Post-deploy this is
    // where the prepared mint call / claim recording hooks in. Gated
    // attempts record nothing, so they can never block a real claim.
    return res.status(409).json({ error: "mint_not_live" });
  });
};
