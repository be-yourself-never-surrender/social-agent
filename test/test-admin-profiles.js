// End-to-end test for the admin + profiles port (BAW version), run
// against a COPY of the backend with the Agent ID registry + USDT
// addresses pointed at ganache mocks (the repo files are untouched).
// Covers: admin wallet-signature login (challenge/verify), adminCheck
// (non-admin 403, EIP-712 moderator session also passes), all
// /api/admin/* read endpoints, voucher create/delete, Blue Tick
// grant/revoke, and the profiles avatar/banner flow (set/remove,
// ownership, handle-required, photo-not-found).
// The admin panel frontend (admins.agentics.forum) calls exactly the
// /api/admin/auth/challenge + /api/admin/auth/verify endpoints tested
// here. Run: npm run test:admin   (from this dir)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ganache = require('ganache');
const { ethers } = require('ethers');

const DIR = path.join(__dirname, 'tmp-admin');
const BACKEND = path.join(DIR, 'backend');
const PORT = 3103;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name, extra || ''); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
async function j(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* non-json */ }
  return { status: r.status, data };
}
async function waitForHealth(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}
// 1x1 PNG (valid image for sharp).
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

(async () => {
  // ---------- ganache + mocks ----------
  const ganacheServer = ganache.server({ logging: { quiet: true }, chain: { chainId: 56 }, wallet: { mnemonic: 'test test test test test test test test test test test junk' } });
  await ganacheServer.listen(8545);
  const provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545');
  const MNEMONIC = 'test test test test test test test test test test test junk';
  const walletAt = i => ethers.Wallet.fromMnemonic(MNEMONIC, `m/44'/60'/0'/0/${i}`).connect(provider);
  const [admin, buyer, buyer2, buyer3] = [0, 1, 2, 3].map(walletAt);
  const adminAddr = await admin.getAddress();
  const buyerAddr = await buyer.getAddress();
  const buyer2Addr = await buyer2.getAddress();
  const buyer3Addr = await buyer3.getAddress();

  const MOCKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'artifacts', 'mocks.json'), 'utf8'));
  const reg = await new ethers.ContractFactory(MOCKS.MockRegistry.abi, MOCKS.MockRegistry.bytecode, admin).deploy();
  await reg.setHandle(buyerAddr, 'buyerone.ai');
  await reg.setHandle(buyer2Addr, 'buyertwo.ai');
  // buyer3 deliberately has NO handle (agent_id_required case).
  console.log('mock registry:', reg.address, '| moderator:', adminAddr);

  // ---------- backend copy with mock addresses ----------
  fs.mkdirSync(DIR, { recursive: true });
  fs.rmSync(BACKEND, { recursive: true, force: true });
  fs.cpSync(path.join(__dirname, '..', 'backend'), BACKEND, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'connect.html'), path.join(DIR, 'connect.html'));
  for (const f of ['social.js', 'blue-tick.js', 'leaderboard.js', 'photos.js']) {
    const fp = path.join(BACKEND, f);
    let c = fs.readFileSync(fp, 'utf8');
    c = c.split('0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F').join(reg.address);
    c = c.split('0x55d398326f99059fF775485246999027B3197955').join('0x0000000000000000000000000000000000000000');
    fs.writeFileSync(fp, c);
  }
  // Fixtures.
  const now = Date.now();
  const social = {
    // Message ids >= 1e15: social.js migrates smaller legacy ids to
    // random 16-digit ids on boot (and rewrites comments/likes, but
    // not reports), so fixtures must already use large ids.
    messages: [
      { id: 1700000000000001, address: buyerAddr, handle: 'buyerone.ai', room: 'social', text: 'hello', ts: now - 1000 },
      { id: 1700000000000002, address: buyer2Addr, handle: 'buyertwo.ai', room: 'social', text: 'world', ts: now - 900 },
    ],
    comments: [
      { id: 1, postId: 1700000000000001, address: buyer2Addr, handle: 'buyertwo.ai', text: 'nice', ts: now },
    ],
    likes: [],
    reposts: [],
    follows: [],
    handles: { [buyerAddr.toLowerCase()]: 'buyerone.ai', [buyer2Addr.toLowerCase()]: 'buyertwo.ai' },
    reports: [
      { id: 1, postId: 1700000000000001, reporter: buyer2Addr, reporterHandle: 'buyertwo.ai', reason: 'spam', ts: now },
    ],
    groups: [],
  };
  fs.writeFileSync(path.join(DIR, 'social.json'), JSON.stringify(social));
  fs.writeFileSync(path.join(DIR, 'vouchers.json'), JSON.stringify({ vouchers: {
    TEST10: { code: 'TEST10', kind: 'discount', days: 365, discountPct: 10, discountUsdt: null, maxUses: 5, usedCount: 0, usedBy: [], createdAt: now, note: 'admin e2e', active: true },
  }}));
  fs.writeFileSync(path.join(DIR, 'blue-tick.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(DIR, 'photos.json'), JSON.stringify({ photos: [], handles: {} }));
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(DIR, 'referrals.json'), JSON.stringify({ referrals: [] }));

  // ---------- start backend ----------
  const env = { ...process.env,
    PORT: String(PORT), HOST: '127.0.0.1',
    BSC_RPC_URL: 'http://127.0.0.1:8545',
    BSC_RPC: 'http://127.0.0.1:8545',
    MODERATOR_ADDRESS: adminAddr,
    BLUE_TICK_DATA: path.join(DIR, 'blue-tick.json'),
    VOUCHERS_DATA: path.join(DIR, 'vouchers.json'),
    SOCIAL_DATA: path.join(DIR, 'social.json'),
    PHOTOS_DATA: path.join(DIR, 'photos.json'),
    PROFILES_DATA: path.join(DIR, 'profiles.json'),
    REFERRALS_DATA: path.join(DIR, 'referrals.json'),
    PHOTOS_DIR: path.join(DIR, 'uploads'),
  };
  const child = spawn('node', ['server.js'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => process.stdout.write('[backend] ' + d));
  child.stderr.on('data', d => process.stdout.write('[backend:err] ' + d));
  const healthy = await waitForHealth();
  ok('backend starts and answers /api/health', healthy);
  if (!healthy) { child.kill(); process.exit(2); }

  async function loginAs(signer) {
    const addr = await signer.getAddress();
    const ch = await j('POST', '/api/auth/challenge', { address: addr });
    if (ch.status !== 200 || !ch.data.typedData) throw new Error('challenge failed: ' + JSON.stringify(ch));
    const td = ch.data.typedData;
    const sig = await signer._signTypedData(td.domain, td.types, td.message);
    const ver = await j('POST', '/api/auth/verify', { address: addr, signature: sig });
    if (ver.status !== 200 || !ver.data.sessionId) throw new Error('verify failed: ' + JSON.stringify(ver));
    return { addr, session: ver.data.sessionId };
  }
  async function uploadPhoto(sessionId) {
    const fd = new FormData();
    fd.append('sessionId', sessionId);
    fd.append('photo', new Blob([PNG_1X1], { type: 'image/png' }), 'avatar.png');
    const r = await fetch(BASE + '/api/social/photos', { method: 'POST', body: fd });
    let data = null;
    try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }

  try {
    // ---------- admin auth ----------
    const noSess = await j('GET', '/api/admin/stats');
    ok('admin stats without session -> 401', noSess.status === 401);
    const { session: buyerSession } = await loginAs(buyer);
    const notAdmin = await j('GET', `/api/admin/stats?sessionId=${buyerSession}`);
    ok('admin stats with non-admin session -> 403', notAdmin.status === 403);
    const chBuyer = await j('POST', '/api/admin/auth/challenge', { address: buyerAddr });
    ok('admin challenge for non-moderator -> 403', chBuyer.status === 403);
    const ch = await j('POST', '/api/admin/auth/challenge', { address: adminAddr });
    ok('admin challenge issued for moderator', ch.status === 200 && ch.data.ok && ch.data.message && ch.data.message.includes(adminAddr.toLowerCase()));
    const badSig = await j('POST', '/api/admin/auth/verify', { address: adminAddr, signature: '0x' + '22'.repeat(65) });
    ok('admin verify with bad signature -> 401', badSig.status === 401);
    const sig = await admin.signMessage(ch.data.message);
    const ver = await j('POST', '/api/admin/auth/verify', { address: adminAddr, signature: sig });
    ok('admin verify with good signature -> 48h session', ver.status === 200 && ver.data.ok && ver.data.sessionId && ver.data.expireAt - Date.now() > 47 * 3600 * 1000);
    const adminSession = ver.data.sessionId;
    const reused = await j('POST', '/api/admin/auth/verify', { address: adminAddr, signature: sig });
    ok('challenge is single-use (replay -> 400)', reused.status === 400);

    // ---------- admin reads ----------
    const stats = await j('GET', `/api/admin/stats?sessionId=${adminSession}`);
    ok('admin stats ok (users 2, posts 2, vouchers 1)', stats.status === 200 && stats.data.ok && stats.data.stats.users === 2 && stats.data.stats.posts === 2 && stats.data.stats.vouchers === 1);
    const posts = await j('GET', `/api/admin/posts?sessionId=${adminSession}&limit=10`);
    ok('admin posts lists 2 posts', posts.status === 200 && posts.data.ok && posts.data.posts.length === 2);
    const users = await j('GET', `/api/admin/users?sessionId=${adminSession}`);
    ok('admin users lists 2 users', users.status === 200 && users.data.ok && users.data.users.length === 2);
    const reports = await j('GET', `/api/admin/reports?sessionId=${adminSession}`);
    ok('admin reports shows post text', reports.status === 200 && reports.data.ok && reports.data.reports.length === 1 && reports.data.reports[0].postText === 'hello');
    const vlist = await j('GET', `/api/admin/vouchers?sessionId=${adminSession}`);
    ok('admin vouchers lists TEST10', vlist.status === 200 && vlist.data.ok && vlist.data.vouchers.length === 1 && vlist.data.vouchers[0].code === 'TEST10');
    const slist = await j('GET', `/api/admin/sessions?sessionId=${adminSession}`);
    ok('admin sessions lists sessions incl. admin', slist.status === 200 && slist.data.ok && slist.data.sessions.some(s => s.sessionId === adminSession));
    const refs = await j('GET', `/api/admin/referrals?sessionId=${adminSession}`);
    ok('admin referrals empty', refs.status === 200 && refs.data.ok && refs.data.referrals.length === 0);
    const listings = await j('GET', `/api/admin/listings?sessionId=${adminSession}`);
    ok('admin listings empty', listings.status === 200 && listings.data.ok && listings.data.listings.length === 0);

    // EIP-712 session for the moderator address also passes adminCheck.
    const { session: adminEip712 } = await loginAs(admin);
    const stats2 = await j('GET', `/api/admin/stats?sessionId=${adminEip712}`);
    ok('EIP-712 moderator session passes adminCheck', stats2.status === 200 && stats2.data.ok);

    // ---------- admin vouchers create/delete ----------
    const created = await j('POST', `/api/admin/vouchers?sessionId=${adminSession}`, { code: 'NEW25', kind: 'discount', discountPct: 25, days: 365, maxUses: 3 });
    ok('admin creates voucher NEW25', created.status === 200 && created.data.ok && created.data.voucher.code === 'NEW25');
    const dup = await j('POST', `/api/admin/vouchers?sessionId=${adminSession}`, { code: 'NEW25', kind: 'discount', discountPct: 25, days: 365, maxUses: 3 });
    ok('duplicate voucher code -> 409', dup.status === 409);
    const del = await j('POST', `/api/admin/vouchers/NEW25/delete?sessionId=${adminSession}`, {});
    ok('admin deletes voucher NEW25', del.status === 200 && del.data.ok);
    // deactivateVoucher is idempotent: deleting an already-inactive
    // voucher still returns ok; only an unknown code is 404.
    const del2 = await j('POST', `/api/admin/vouchers/NEW25/delete?sessionId=${adminSession}`, {});
    ok('delete of inactive voucher is idempotent (200)', del2.status === 200 && del2.data.ok);
    const del3 = await j('POST', `/api/admin/vouchers/NOPE/delete?sessionId=${adminSession}`, {});
    ok('delete of unknown voucher -> 404', del3.status === 404);

    // ---------- admin Blue Tick grant/revoke ----------
    const grant = await j('POST', `/api/admin/bluetick/grant?sessionId=${adminSession}`, { handle: 'buyerone.ai', days: 30 });
    ok('admin grants Blue Tick 30d', grant.status === 200 && grant.data.ok && grant.data.expiresAt - Date.now() > 29 * 86400 * 1000 && grant.data.expiresAt - Date.now() <= 30 * 86400 * 1000 + 60000);
    const holders = await j('GET', `/api/admin/bluetick?sessionId=${adminSession}`);
    ok('admin bluetick lists the granted holder', holders.status === 200 && holders.data.ok && holders.data.holders.length === 1 && holders.data.holders[0].handle === 'buyerone.ai');
    const revoke = await j('POST', `/api/admin/bluetick/revoke?sessionId=${adminSession}`, { handle: 'buyerone.ai' });
    ok('admin revokes Blue Tick', revoke.status === 200 && revoke.data.ok);
    const revoke2 = await j('POST', `/api/admin/bluetick/revoke?sessionId=${adminSession}`, { handle: 'buyerone.ai' });
    ok('revoke of missing tick -> 404', revoke2.status === 404);

    // ---------- profiles ----------
    const up = await uploadPhoto(buyerSession);
    ok('photo upload works', up.status === 200 && up.data.ok && up.data.photo && up.data.photo.id && up.data.photo.url);
    const photoId = up.data.photo.id;
    const photoUrl = up.data.photo.url;
    const { session: buyer2Session } = await loginAs(buyer2);
    const up2 = await uploadPhoto(buyer2Session);
    ok('second wallet photo upload works', up2.status === 200 && up2.data.ok);
    const otherPhotoId = up2.data.photo.id;

    const setAv = await j('POST', '/api/social/profile/avatar', { sessionId: buyerSession, photoId });
    ok('set avatar ok', setAv.status === 200 && setAv.data.ok && setAv.data.avatarUrl === photoUrl && setAv.data.handle === 'buyerone.ai');
    const stored = JSON.parse(fs.readFileSync(path.join(DIR, 'profiles.json'), 'utf8'));
    ok('profiles.json stores the avatar', stored['buyerone.ai'] && stored['buyerone.ai'].avatarUrl === photoUrl && stored['buyerone.ai'].avatarPhotoId === photoId);
    const notYours = await j('POST', '/api/social/profile/avatar', { sessionId: buyerSession, photoId: otherPhotoId });
    ok("set avatar with another wallet's photo -> 403", notYours.status === 403 && notYours.data.error === 'photo_not_yours');
    const noPhoto = await j('POST', '/api/social/profile/avatar', { sessionId: buyerSession, photoId: 'doesnotexist' });
    ok('set avatar with unknown photo -> 404', noPhoto.status === 404);
    const { session: buyer3Session } = await loginAs(buyer3);
    const noHandle = await j('POST', '/api/social/profile/avatar', { sessionId: buyer3Session, photoId });
    ok('set avatar without Agent ID handle -> 403', noHandle.status === 403 && noHandle.data.error === 'agent_id_required');
    const badSess = await j('POST', '/api/social/profile/avatar', { sessionId: 'nope', photoId });
    ok('set avatar with invalid session -> 401', badSess.status === 401);
    const setBanner = await j('POST', '/api/social/profile/banner', { sessionId: buyerSession, photoId });
    ok('set banner ok (same photo reusable for banner)', setBanner.status === 200 && setBanner.data.ok && setBanner.data.bannerUrl === photoUrl);
    const rmAv = await j('POST', '/api/social/profile/avatar/remove', { sessionId: buyerSession });
    ok('remove avatar ok', rmAv.status === 200 && rmAv.data.ok);
    const rmBn = await j('POST', '/api/social/profile/banner/remove', { sessionId: buyerSession });
    ok('remove banner ok', rmBn.status === 200 && rmBn.data.ok);
    const stored2 = JSON.parse(fs.readFileSync(path.join(DIR, 'profiles.json'), 'utf8'));
    ok('profiles.json cleared after remove', stored2['buyerone.ai'] && stored2['buyerone.ai'].avatarUrl === null && stored2['buyerone.ai'].bannerUrl === null);
    // Freed photo can be deleted now (no longer referenced).
    const delPhoto = await j('POST', `/api/social/photos/${photoId}/delete`, { sessionId: buyerSession });
    ok('freed profile photo deletable', delPhoto.status === 200 && delPhoto.data.ok);

  } finally {
    child.kill('SIGTERM');
    await ganacheServer.close();
  }
  console.log(`\nADMIN-PROFILES RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
