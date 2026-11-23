// Auction frontend. Talks to the prototype backend on the same origin.
let handle = localStorage.getItem('auction_handle') || '';
let current = null;
let user = null;
let filter = 'all';

function fmt(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function msg(text) {
  document.getElementById('msg').textContent = text;
}

async function api(path, body) {
  const opts = body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : {};
  const r = await fetch(path, opts);
  const j = await r.json();
  if (!r.ok) throw new Error((j.error || 'request_failed') + (j.minCents !== undefined ? ' (min ' + fmt(j.minCents) + ')' : '') + (j.openCents !== undefined ? ' (open ' + fmt(j.openCents) + ')' : ''));
  return j;
}

function renderUser() {
  const line = document.getElementById('userLine');
  const stats = document.getElementById('userStats');
  if (!user) {
    line.textContent = 'Set a handle to see your balance, bids, wins and suspension status.';
    stats.innerHTML = '';
    return;
  }
  let status = 'Active';
  if (user.suspended) status = 'Suspended until round ' + user.suspendedUntil;
  else if (user.reentryRound === currentRoundNum()) status = 'Re-entry round: 1 table max';
  line.textContent = 'Handle: ' + user.handle + ' | Status: ' + status;
  stats.innerHTML =
    '<span class="stat">Balance: <b>' + fmt(user.balanceCents) + '</b> demo USDT</span>' +
    '<span class="stat">Active bids: <b>' + user.activeBids + '/' + user.activeCap + '</b></span>' +
    '<span class="stat">Wins: <b>' + user.wins + '</b></span>' +
    '<span class="stat">Refundable: <b>' + fmt(user.refundableCents) + '</b></span>';
  const dist = document.getElementById('distLine');
  if (!user.allocations.length) {
    dist.innerHTML = '<p class="muted">No distributor allocations yet.</p>';
  } else {
    dist.innerHTML = user.allocations.map((a) => {
      const btn = a.claimed
        ? '<span class="muted">Claimed</span>'
        : '<button data-claim-round="' + a.round + '">Claim ' + a.tokens.toLocaleString('en-US') + ' tokens</button>';
      return '<p>Day ' + a.round + ': tables ' + a.tables.join(', ') + ' | ' + a.lots + ' lot(s) | ' + btn + '</p>';
    }).join('');
    dist.querySelectorAll('[data-claim-round]').forEach((b) => {
      b.onclick = async () => {
        try {
          const j = await api('/api/distributor/claim', { handle, round: parseInt(b.dataset.claimRound, 10) });
          msg('Claimed ' + j.tokens.toLocaleString('en-US') + ' tokens from day ' + b.dataset.claimRound + '.');
          await load();
        } catch (e) { msg('Claim failed: ' + e.message); }
      };
    });
  }
}

function currentRoundNum() {
  return current && current.round ? current.round.round : null;
}

function renderRound() {
  if (!current) return;
  const title = document.getElementById('roundTitle');
  const stats = document.getElementById('roundStats');
  if (current.auctionClosed) {
    title.textContent = 'Auction closed';
    stats.innerHTML = '<span class="stat">All 5 days settled.</span>' +
      '<span class="stat">Liquidator: <b>' + fmt(current.liquidatorCents) + '</b></span>' +
      '<span class="stat">Listing: <b>' + (current.listingOpen ? 'Open' : 'Closed') + '</b></span>';
    document.getElementById('tables').innerHTML = '<p class="muted">Auction finished. Distributor claims open when listing opens.</p>';
    return;
  }
  const r = current.round;
  title.textContent = 'Day ' + r.round + ' of 5';
  const closeText = new Date(r.closeAt).toLocaleString('en-US');
  stats.innerHTML =
    '<span class="stat">Open: <b>' + fmt(r.openCents) + '</b></span>' +
    '<span class="stat">Step: <b>' + fmt(r.stepCents) + '</b></span>' +
    '<span class="stat">Closes: <b>' + closeText + '</b></span>' +
    '<span class="stat">Sold: <b>' + r.soldCount + '/100</b></span>' +
    (r.avgCloseCents !== null ? '<span class="stat">Avg close: <b>' + fmt(r.avgCloseCents) + '</b></span>' : '') +
    '<span class="stat">Liquidator: <b>' + fmt(current.liquidatorCents) + '</b></span>';
  renderTables(r);
}

function renderTables(r) {
  const box = document.getElementById('tables');
  let tables = r.tables;
  if (filter === 'mine' && handle) {
    tables = tables.filter((t) => (t.top && t.top.handle === handle) || t.myEscrow > 0);
  } else if (filter === 'open') {
    tables = tables.filter((t) => !t.top);
  }
  if (!tables.length) {
    box.innerHTML = '<p class="muted">No tables match this filter.</p>';
    return;
  }
  box.innerHTML = tables.map((t) => {
    const mine = t.top && t.top.handle === handle;
    const topLine = t.top ? fmt(t.top.amount) + ' by ' + t.top.handle : 'Open at ' + fmt(r.openCents);
    const escrowLine = t.myEscrow > 0 ? '<p>Your escrow: <b>' + fmt(t.myEscrow) + '</b></p>' : '';
    const topupBtn = t.myEscrow > 0 ? '<button data-topup="' + t.id + '" class="secondary">Top up by input</button><button data-claim="' + t.id + '" class="secondary">Claim refund</button>' : '';
    return '<div class="table' + (mine ? ' mine' : '') + '">' +
      '<h3>Table ' + t.id + '</h3>' +
      '<p>Lot: <b>400,000</b></p>' +
      '<p>Top: <b>' + topLine + '</b></p>' +
      escrowLine +
      '<input data-amount="' + t.id + '" placeholder="Bid in USDT, for example 9.00">' +
      '<button data-bid="' + t.id + '">Bid</button>' +
      topupBtn +
      '</div>';
  }).join('');
  box.querySelectorAll('[data-bid]').forEach((b) => {
    b.onclick = async () => {
      if (!handle) { msg('Set a handle first.'); return; }
      const input = box.querySelector('[data-amount="' + b.dataset.bid + '"]');
      const cents = Math.round(parseFloat(input.value) * 100);
      if (!Number.isFinite(cents) || cents <= 0) { msg('Enter a valid bid amount.'); return; }
      try {
        await api('/api/bid', { handle, table: parseInt(b.dataset.bid, 10), amountCents: cents });
        msg('Bid placed on table ' + b.dataset.bid + ' at ' + fmt(cents) + '.');
        await load();
      } catch (e) { msg('Bid failed: ' + e.message); }
    };
  });
  box.querySelectorAll('[data-topup]').forEach((b) => {
    b.onclick = async () => {
      if (!handle) { msg('Set a handle first.'); return; }
      const input = box.querySelector('[data-amount="' + b.dataset.topup + '"]');
      const cents = Math.round(parseFloat(input.value) * 100);
      if (!Number.isFinite(cents) || cents <= 0) { msg('Enter a valid top-up amount.'); return; }
      try {
        await api('/api/topup', { handle, table: parseInt(b.dataset.topup, 10), addCents: cents });
        msg('Topped up table ' + b.dataset.topup + ' by ' + fmt(cents) + '.');
        await load();
      } catch (e) { msg('Top-up failed: ' + e.message); }
    };
  });
  box.querySelectorAll('[data-claim]').forEach((b) => {
    b.onclick = async () => {
      try {
        const j = await api('/api/claim', { handle });
        msg('Claimed refunds: ' + fmt(j.claimedCents) + '.');
        await load();
      } catch (e) { msg('Claim failed: ' + e.message); }
    };
  });
}

async function load() {
  const q = handle ? '?handle=' + encodeURIComponent(handle) : '';
  current = await api('/api/rounds/current' + q);
  if (handle) {
    try { user = await api('/api/user/' + encodeURIComponent(handle)); } catch (e) { user = null; }
  } else {
    user = null;
  }
  document.getElementById('handle').value = handle;
  renderRound();
  renderUser();
}

document.getElementById('setHandle').onclick = () => {
  const v = document.getElementById('handle').value.trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,32}$/.test(v)) { msg('Handle must be 1 to 32 chars: letters, digits, dot, underscore, dash.'); return; }
  handle = v;
  localStorage.setItem('auction_handle', handle);
  load().then(() => msg('Handle set: ' + handle + '.')).catch((e) => msg('Load failed: ' + e.message));
};
document.getElementById('claimAll').onclick = async () => {
  if (!handle) { msg('Set a handle first.'); return; }
  try {
    const j = await api('/api/claim', { handle });
    msg('Claimed refunds: ' + fmt(j.claimedCents) + '.');
    await load();
  } catch (e) { msg('Claim failed: ' + e.message); }
};
document.getElementById('filterAll').onclick = () => { filter = 'all'; renderRound(); };
document.getElementById('filterMine').onclick = () => { filter = 'mine'; renderRound(); };
document.getElementById('filterOpen').onclick = () => { filter = 'open'; renderRound(); };
document.getElementById('refresh').onclick = () => load().catch((e) => msg('Load failed: ' + e.message));
document.getElementById('closeRound').onclick = async () => {
  if (!confirm('Close the current round now? This settles all 100 tables.')) return;
  try {
    const j = await api('/api/admin/close-round', {});
    msg('Round closed. Now on day ' + j.round + (j.auctionClosed ? ' (auction finished).' : '.'));
    await load();
  } catch (e) { msg('Close failed: ' + e.message); }
};
document.getElementById('openListing').onclick = async () => {
  try {
    await api('/api/admin/open-listing', {});
    msg('Listing opened. Distributor claims are now available.');
    await load();
  } catch (e) { msg('Open listing failed: ' + e.message); }
};
document.getElementById('resetDemo').onclick = async () => {
  if (!confirm('Reset all demo state? This erases every bid, win and balance.')) return;
  try {
    await api('/api/admin/reset', {});
    msg('Demo state reset.');
    await load();
  } catch (e) { msg('Reset failed: ' + e.message); }
};

load().catch((e) => msg('Load failed: ' + e.message));
setInterval(() => load().catch(() => {}), 30000);
