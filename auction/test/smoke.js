// Smoke test for the auction prototype backend.
// Run against a server started on PORT (default 3003).
// Covers: bid, outbid, top-up, active cap, step validation, close average,
// suspension after 2 wins, re-entry with 1 table, distributor gate, liquidator.
const BASE = 'http://localhost:' + (process.env.PORT || '3003');

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('PASS ' + name);
  } else {
    failures++;
    console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  }
}

async function api(path, body) {
  const opts = body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : {};
  const r = await fetch(BASE + path, opts);
  const j = await r.json();
  return { ok: r.ok, status: r.status, json: j };
}

async function main() {
  let r = await api('/api/admin/reset', {});
  check('reset', r.ok);

  r = await api('/api/rounds/current');
  check('round 1 open 500 step 50', r.json.round && r.json.round.openCents === 500 && r.json.round.stepCents === 50, r.json);

  // Bid, outbid, top-up.
  r = await api('/api/bid', { handle: 'anjing.ai', table: 1, amountCents: 800 });
  check('anjing bids table 1 at 800', r.ok, r.json);
  r = await api('/api/bid', { handle: 'babi.ai', table: 1, amountCents: 850 });
  check('babi outbids at 850', r.ok, r.json);
  r = await api('/api/bid', { handle: 'anjing.ai', table: 1, amountCents: 800 });
  check('stale bid rejected', !r.ok, r.json);
  r = await api('/api/topup', { handle: 'anjing.ai', table: 1, addCents: 100 });
  check('anjing tops up to 900', r.ok && r.json.table.top.amount === 900, r.json);

  // Active cap: anjing is top on table 1, bids table 2, then table 3 must fail.
  r = await api('/api/bid', { handle: 'anjing.ai', table: 2, amountCents: 500 });
  check('anjing bids table 2', r.ok, r.json);
  r = await api('/api/bid', { handle: 'anjing.ai', table: 3, amountCents: 500 });
  check('third active bid rejected', !r.ok && r.json.error === 'active_cap', r.json);

  // babi takes table 2, anjing escrow on table 2 becomes refundable.
  r = await api('/api/bid', { handle: 'babi.ai', table: 2, amountCents: 550 });
  check('babi takes table 2 at 550', r.ok, r.json);
  r = await api('/api/claim', { handle: 'anjing.ai' });
  check('anjing claims 500 refund', r.ok && r.json.claimedCents === 500, r.json);

  // Step and open validation.
  r = await api('/api/bid', { handle: 'babi.ai', table: 4, amountCents: 525 });
  check('bad step rejected', !r.ok && r.json.error === 'bad_step', r.json);
  r = await api('/api/bid', { handle: 'babi.ai', table: 4, amountCents: 400 });
  check('below open rejected', !r.ok && r.json.error === 'below_open', r.json);

  // Close round 1: anjing wins table 1 (900), babi wins table 2 (550).
  // Average = 725, so round 2 opens at 725 with step 80.
  r = await api('/api/admin/close-round', {});
  check('round 1 closed', r.ok && r.json.round === 2, r.json);
  r = await api('/api/rounds/current');
  check('round 2 open 725 step 80', r.json.round.openCents === 725 && r.json.round.stepCents === 80, r.json.round);

  // anjing wins a second lot in round 2, then is suspended for rounds 3-5.
  r = await api('/api/bid', { handle: 'anjing.ai', table: 1, amountCents: 725 });
  check('anjing bids round 2', r.ok, r.json);
  r = await api('/api/admin/close-round', {});
  check('round 2 closed', r.ok && r.json.round === 3, r.json);
  r = await api('/api/bid', { handle: 'anjing.ai', table: 1, amountCents: 725 });
  check('suspended bid rejected', !r.ok && r.json.error === 'suspended', r.json);

  // Distributor gate: claims blocked until listing opens.
  r = await api('/api/distributor/claim', { handle: 'anjing.ai', round: 1 });
  check('distributor claim blocked pre listing', !r.ok && r.json.error === 'listing_not_open', r.json);
  r = await api('/api/admin/open-listing', {});
  check('listing opened', r.ok, r.json);
  r = await api('/api/distributor/claim', { handle: 'anjing.ai', round: 1 });
  check('anjing claims 400000 tokens round 1', r.ok && r.json.tokens === 400000, r.json);
  r = await api('/api/distributor/claim', { handle: 'anjing.ai', round: 1 });
  check('double claim rejected', !r.ok && r.json.error === 'nothing_to_claim', r.json);

  // Liquidator so far: 900 + 550 + 725 = 2175.
  r = await api('/api/rounds/current');
  check('liquidator 2175', r.json.liquidatorCents === 2175, r.json.liquidatorCents);

  // Re-entry scenario: fresh state, early.ai wins 2 lots in round 1.
  await api('/api/admin/reset', {});
  await api('/api/bid', { handle: 'early.ai', table: 1, amountCents: 500 });
  await api('/api/bid', { handle: 'early.ai', table: 2, amountCents: 500 });
  r = await api('/api/admin/close-round', {});
  check('re-entry setup: round 2 reached', r.ok && r.json.round === 2, r.json);
  r = await api('/api/bid', { handle: 'early.ai', table: 1, amountCents: 500 });
  check('re-entry setup: suspended in round 2', !r.ok && r.json.error === 'suspended', r.json);
  await api('/api/admin/close-round', {});
  await api('/api/admin/close-round', {});
  await api('/api/admin/close-round', {});
  r = await api('/api/rounds/current');
  check('re-entry setup: round 5 reached', r.json.round && r.json.round.round === 5, r.json);
  r = await api('/api/bid', { handle: 'early.ai', table: 1, amountCents: 500 });
  check('early.ai re-enters round 5', r.ok, r.json);
  r = await api('/api/bid', { handle: 'early.ai', table: 2, amountCents: 500 });
  check('re-entry second table rejected (cap 1)', !r.ok && r.json.error === 'active_cap', r.json);
  r = await api('/api/admin/close-round', {});
  check('round 5 closed, auction finished', r.ok && r.json.auctionClosed === true, r.json);
  r = await api('/api/user/early.ai');
  check('early.ai has 3 wins', r.json.wins === 3, r.json);

  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
