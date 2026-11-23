// Auction backend prototype. Node stdlib only, no dependencies.
// Rules implemented from ../SPEC.md. Pre-contract prototype: balances are
// demo USDT and escrow / distributor / liquidator are accounting only.
// All money amounts are integer cents. 1 USDT = 100 cents.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3002', 10);
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const TOTAL_ROUNDS = 5;
const TABLES_PER_ROUND = 100;
const LOT = 400000;
const ROUND_MS = parseInt(process.env.ROUND_MS || '86400000', 10);
const DEMO_BALANCE_CENTS = 100000000; // 1,000,000 demo USDT

function stepFor(openCents) {
  // Step = 10 percent of open, rounded UP to the nearest 10 cents.
  return Math.ceil((openCents * 0.10) / 10) * 10;
}

function newRoundState(n, openCents, closeAt) {
  const tables = {};
  for (let i = 1; i <= TABLES_PER_ROUND; i++) {
    tables[i] = { id: i, lot: LOT, top: null, escrows: {} };
  }
  return {
    round: n, openCents, stepCents: stepFor(openCents), closeAt,
    closed: false, tables, soldCount: 0, unsoldCount: 0, avgCloseCents: null,
  };
}

function defaultState() {
  const now = Date.now();
  return {
    round: 1,
    auctionClosed: false,
    listingOpen: false,
    rounds: { 1: newRoundState(1, 500, now + ROUND_MS) },
    users: {},
    liquidatorCents: 0,
    distributors: {},
  };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return defaultState();
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DATA_FILE);
}

function normalizeHandle(h) {
  if (typeof h !== 'string') return null;
  const v = h.trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,32}$/.test(v)) return null;
  return v;
}

function getUser(state, handle) {
  if (!state.users[handle]) {
    state.users[handle] = {
      handle, balanceCents: DEMO_BALANCE_CENTS, wins: 0,
      suspendedUntil: null, reentryRound: null,
    };
  }
  return state.users[handle];
}

function currentRound(state) {
  return state.rounds[state.round];
}

function isSuspended(user, round) {
  return user.suspendedUntil !== null && round <= user.suspendedUntil;
}

function activeCap(user, round) {
  return user.reentryRound === round ? 1 : 2;
}

function activeBidCount(state, handle) {
  const r = currentRound(state);
  let n = 0;
  for (const t of Object.values(r.tables)) {
    if (t.top && t.top.handle === handle) n++;
  }
  return n;
}

function refundableCents(state, handle) {
  let sum = 0;
  for (const r of Object.values(state.rounds)) {
    for (const t of Object.values(r.tables)) {
      if (t.escrows[handle]) sum += t.escrows[handle];
    }
  }
  return sum;
}

function publicUser(state, user) {
  const round = state.round;
  const allocations = [];
  for (const d of Object.values(state.distributors)) {
    const mine = d.winners.filter((w) => w.handle === user.handle);
    if (mine.length) {
      allocations.push({
        round: d.round,
        tables: mine.map((w) => w.table),
        lots: mine.length,
        tokens: mine.length * LOT,
        claimed: mine.every((w) => w.claimed),
      });
    }
  }
  return {
    handle: user.handle,
    balanceCents: user.balanceCents,
    wins: user.wins,
    activeBids: state.auctionClosed ? 0 : activeBidCount(state, user.handle),
    activeCap: state.auctionClosed ? 0 : activeCap(user, round),
    suspendedUntil: user.suspendedUntil,
    reentryRound: user.reentryRound,
    suspended: state.auctionClosed ? false : isSuspended(user, round),
    refundableCents: refundableCents(state, user.handle),
    allocations,
  };
}

function roundView(state, roundNum, handle) {
  const r = state.rounds[roundNum];
  if (!r) return null;
  const tables = Object.values(r.tables).map((t) => ({
    id: t.id,
    lot: t.lot,
    top: t.top,
    myEscrow: handle ? (t.escrows[handle] || 0) : 0,
  }));
  return {
    round: r.round,
    openCents: r.openCents,
    stepCents: r.stepCents,
    closeAt: r.closeAt,
    closed: r.closed,
    soldCount: r.soldCount,
    unsoldCount: r.unsoldCount,
    avgCloseCents: r.avgCloseCents,
    tables,
  };
}

// Shared core for bid and top-up. targetCents is the desired total bid.
// newMoney is what the user must pay now (target minus own escrow on table).
function placeBid(state, user, table, targetCents, newMoney) {
  const r = currentRound(state);
  if (state.auctionClosed) return { error: 'auction_closed' };
  if (isSuspended(user, r.round)) return { error: 'suspended', suspendedUntil: user.suspendedUntil };
  if (!Number.isInteger(targetCents) || targetCents <= 0) return { error: 'bad_amount' };
  if (targetCents < r.openCents) return { error: 'below_open', openCents: r.openCents };
  if ((targetCents - r.openCents) % r.stepCents !== 0) return { error: 'bad_step', stepCents: r.stepCents };
  if (table.top && table.top.handle === user.handle) return { error: 'already_top' };
  if (table.top && targetCents < table.top.amount + r.stepCents) {
    return { error: 'below_top_plus_step', minCents: table.top.amount + r.stepCents };
  }
  if (newMoney < 0) return { error: 'below_own_escrow' };
  if (newMoney === 0) return { error: 'no_change' };
  if (activeBidCount(state, user.handle) >= activeCap(user, r.round)) {
    return { error: 'active_cap', cap: activeCap(user, r.round) };
  }
  if (user.balanceCents < newMoney) return { error: 'insufficient', needCents: newMoney };
  // Previous top bidder's money stays locked as refundable escrow.
  if (table.top) {
    const prev = table.top;
    table.escrows[prev.handle] = (table.escrows[prev.handle] || 0) + prev.amount;
  }
  user.balanceCents -= newMoney;
  delete table.escrows[user.handle];
  table.top = { handle: user.handle, amount: targetCents };
  return { ok: true };
}

function settleRound(state) {
  const r = currentRound(state);
  if (!r || r.closed) return;
  const winnersBefore = {};
  for (const h of Object.keys(state.users)) winnersBefore[h] = state.users[h].wins;
  let sum = 0;
  let sold = 0;
  let unsold = 0;
  const dist = { round: r.round, winners: [] };
  for (const t of Object.values(r.tables)) {
    if (t.top) {
      sold++;
      sum += t.top.amount;
      const u = getUser(state, t.top.handle);
      u.wins += 1;
      state.liquidatorCents += t.top.amount;
      dist.winners.push({ handle: t.top.handle, table: t.id, lot: LOT, claimed: false });
    } else {
      unsold++;
    }
  }
  r.soldCount = sold;
  r.unsoldCount = unsold;
  // Provisional rule (SPEC open item): unsold tables are excluded from the
  // average. If nothing sold, the next open keeps the current open.
  r.avgCloseCents = sold > 0 ? Math.round(sum / sold) : null;
  r.closed = true;
  state.distributors[r.round] = dist;
  // Suspension trigger: wins reached 2 at this close.
  for (const u of Object.values(state.users)) {
    if (winnersBefore[u.handle] < 2 && u.wins >= 2) {
      u.suspendedUntil = r.round + 3;
      u.reentryRound = r.round + 4;
    }
  }
  if (r.round >= TOTAL_ROUNDS) {
    state.auctionClosed = true;
  } else {
    const nextOpen = r.avgCloseCents !== null ? r.avgCloseCents : r.openCents;
    state.round += 1;
    state.rounds[state.round] = newRoundState(state.round, nextOpen, Date.now() + ROUND_MS);
  }
}

function autoSettle(state) {
  while (!state.auctionClosed) {
    const r = currentRound(state);
    if (!r || Date.now() < r.closeAt) break;
    settleRound(state);
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100000) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathName = url.pathname;
  try {
    if (pathName === '/api/health') {
      return sendJson(res, 200, { ok: true, prototype: true });
    }
    if (pathName.startsWith('/api/')) {
      const state = loadState();
      if (req.method === 'GET' && pathName === '/api/rounds/current') {
        autoSettle(state); saveState(state);
        return sendJson(res, 200, {
          auctionClosed: state.auctionClosed,
          listingOpen: state.listingOpen,
          liquidatorCents: state.liquidatorCents,
          round: state.auctionClosed ? null : roundView(state, state.round, url.searchParams.get('handle')),
        });
      }
      if (req.method === 'GET' && /^\/api\/rounds\/\d+$/.test(pathName)) {
        const n = parseInt(pathName.split('/')[3], 10);
        const v = roundView(state, n, url.searchParams.get('handle'));
        if (!v) return sendJson(res, 404, { error: 'no_round' });
        return sendJson(res, 200, v);
      }
      if (req.method === 'GET' && /^\/api\/user\/[^/]+$/.test(pathName)) {
        const handle = normalizeHandle(decodeURIComponent(pathName.split('/')[3]));
        if (!handle) return sendJson(res, 400, { error: 'bad_handle' });
        const user = getUser(state, handle);
        saveState(state);
        return sendJson(res, 200, publicUser(state, user));
      }
      if (req.method === 'POST' && pathName === '/api/bid') {
        const b = await readBody(req);
        autoSettle(state);
        const handle = normalizeHandle(b.handle);
        const tableId = parseInt(b.table, 10);
        const amount = parseInt(b.amountCents, 10);
        if (!handle || !Number.isInteger(tableId)) return sendJson(res, 400, { error: 'bad_input' });
        const user = getUser(state, handle);
        const r = currentRound(state);
        if (!r) return sendJson(res, 400, { error: 'auction_closed' });
        const table = r.tables[tableId];
        if (!table) return sendJson(res, 400, { error: 'bad_table' });
        const escrow = table.escrows[handle] || 0;
        const result = placeBid(state, user, table, amount, amount - escrow);
        if (result.error) return sendJson(res, 400, result);
        saveState(state);
        return sendJson(res, 200, { ok: true, table: { id: table.id, top: table.top }, user: publicUser(state, user) });
      }
      if (req.method === 'POST' && pathName === '/api/topup') {
        const b = await readBody(req);
        autoSettle(state);
        const handle = normalizeHandle(b.handle);
        const tableId = parseInt(b.table, 10);
        const add = parseInt(b.addCents, 10);
        if (!handle || !Number.isInteger(tableId) || !Number.isInteger(add) || add <= 0) {
          return sendJson(res, 400, { error: 'bad_input' });
        }
        const user = getUser(state, handle);
        const r = currentRound(state);
        if (!r) return sendJson(res, 400, { error: 'auction_closed' });
        const table = r.tables[tableId];
        if (!table) return sendJson(res, 400, { error: 'bad_table' });
        const escrow = table.escrows[handle] || 0;
        if (escrow === 0) return sendJson(res, 400, { error: 'no_escrow_topup_use_bid' });
        const result = placeBid(state, user, table, escrow + add, add);
        if (result.error) return sendJson(res, 400, result);
        saveState(state);
        return sendJson(res, 200, { ok: true, table: { id: table.id, top: table.top }, user: publicUser(state, user) });
      }
      if (req.method === 'POST' && pathName === '/api/claim') {
        const b = await readBody(req);
        const handle = normalizeHandle(b.handle);
        if (!handle) return sendJson(res, 400, { error: 'bad_handle' });
        const user = getUser(state, handle);
        let claimed = 0;
        for (const r of Object.values(state.rounds)) {
          for (const t of Object.values(r.tables)) {
            if (t.escrows[handle]) { claimed += t.escrows[handle]; delete t.escrows[handle]; }
          }
        }
        user.balanceCents += claimed;
        saveState(state);
        return sendJson(res, 200, { ok: true, claimedCents: claimed, user: publicUser(state, user) });
      }
      if (req.method === 'POST' && pathName === '/api/distributor/claim') {
        const b = await readBody(req);
        const handle = normalizeHandle(b.handle);
        const roundNum = parseInt(b.round, 10);
        if (!handle || !Number.isInteger(roundNum)) return sendJson(res, 400, { error: 'bad_input' });
        if (!state.listingOpen) return sendJson(res, 400, { error: 'listing_not_open' });
        const d = state.distributors[roundNum];
        if (!d) return sendJson(res, 404, { error: 'no_distributor' });
        const mine = d.winners.filter((w) => w.handle === handle && !w.claimed);
        if (!mine.length) return sendJson(res, 400, { error: 'nothing_to_claim' });
        for (const w of mine) w.claimed = true;
        saveState(state);
        return sendJson(res, 200, { ok: true, tokens: mine.length * LOT, tables: mine.map((w) => w.table) });
      }
      if (req.method === 'POST' && pathName === '/api/admin/close-round') {
        if (state.auctionClosed) return sendJson(res, 400, { error: 'auction_closed' });
        settleRound(state);
        saveState(state);
        return sendJson(res, 200, { ok: true, round: state.round, auctionClosed: state.auctionClosed });
      }
      if (req.method === 'POST' && pathName === '/api/admin/open-listing') {
        state.listingOpen = true;
        saveState(state);
        return sendJson(res, 200, { ok: true, listingOpen: true });
      }
      if (req.method === 'POST' && pathName === '/api/admin/reset') {
        const fresh = defaultState();
        saveState(fresh);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'not_found' });
    }
    // Static frontend.
    let filePath = pathName === '/' ? '/index.html' : pathName;
    filePath = path.normalize(path.join(FRONTEND_DIR, filePath));
    if (!filePath.startsWith(FRONTEND_DIR)) return sendJson(res, 403, { error: 'forbidden' });
    const ext = path.extname(filePath);
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') return sendJson(res, 404, { error: 'not_found' });
    return sendJson(res, 500, { error: 'server_error' });
  }
});

server.listen(PORT, () => {
  console.log('Auction prototype listening on port ' + PORT);
});
