// End-to-end test for the hackathon fix, run against a COPY of the
// backend with the Agent ID registry + USDT addresses pointed at
// ganache mocks (the repo files are untouched; the only difference
// from production is those two addresses).
// Covers: EIP-712 login, connect-link (mint/redeem/reuse/expiry),
// session status/disconnect, leaderboard scoring, Blue Tick quote /
// authorize / mint / confirm / expiry / renew, free + discount
// vouchers, legacy migration, and the social write gate (1000 chars
// only with an active tick).
// Run: npm run compile && npm run test:backend   (from this dir)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ganache = require('ganache');
const { ethers } = require('ethers');

const DIR = path.join(__dirname, 'tmp-e2e');
const BACKEND = path.join(DIR, 'backend');
const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const PRICE = ethers.utils.parseUnits('5', 18); // 5 USDT, 18 decimals on BSC
const MINT_BAL = ethers.utils.parseUnits('100', 18);
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

(async () => {
  // ---------- ganache (HTTP server, so the backend child process can reach it) + mocks ----------
  const ganacheServer = ganache.server({ logging: { quiet: true }, chain: { chainId: 56 }, wallet: { mnemonic: 'test test test test test test test test test test test junk' } });
  await ganacheServer.listen(8545);
  const provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545');
  // Local wallets (sign EIP-712 locally): the test mnemonic's accounts
  // match ganache's default HD accounts, so these ARE the funded signers.
  const MNEMONIC = 'test test test test test test test test test test test junk';
  const walletAt = i => ethers.Wallet.fromMnemonic(MNEMONIC, `m/44'/60'/0'/0/${i}`).connect(provider);
  const [deployer, buyer, buyer2, buyer3] = [0, 1, 2, 3].map(walletAt);
  const deployerAddr = await deployer.getAddress();
  const buyerAddr = await buyer.getAddress();
  const buyer2Addr = await buyer2.getAddress();
  const buyer3Addr = await buyer3.getAddress();
  const authorizer = ethers.Wallet.createRandom().connect(provider);
  const authorizerAddr = await authorizer.getAddress();

  const BT = JSON.parse(fs.readFileSync(path.join(__dirname, 'artifacts', 'BlueTickNFT.json'), 'utf8'));
  const MOCKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'artifacts', 'mocks.json'), 'utf8'));
  const usdt = await new ethers.ContractFactory(MOCKS.MockUSDT.abi, MOCKS.MockUSDT.bytecode, deployer).deploy();
  const reg = await new ethers.ContractFactory(MOCKS.MockRegistry.abi, MOCKS.MockRegistry.bytecode, deployer).deploy();
  const bt = await new ethers.ContractFactory(BT.abi, BT.bytecode, deployer).deploy(usdt.address, deployerAddr, authorizerAddr, reg.address);
  for (const [s, h] of [[buyer, 'buyerone.ai'], [buyer2, 'buyertwo.ai'], [buyer3, 'buyerthree.ai']]) {
    await reg.setHandle(await s.getAddress(), h);
    await usdt.mint(await s.getAddress(), MINT_BAL);
    await usdt.connect(s).approve(bt.address, ethers.constants.MaxUint256);
  }
  console.log('mock registry:', reg.address, '| mock USDT:', usdt.address, '| BlueTickNFT:', bt.address);

  // ---------- backend copy with mock addresses ----------
  fs.mkdirSync(DIR, { recursive: true });
  fs.rmSync(BACKEND, { recursive: true, force: true });
  fs.cpSync(path.join(__dirname, '..', 'backend'), BACKEND, { recursive: true });
  // Production layout: connect.html lives at the repo root, next to backend/.
  fs.copyFileSync(path.join(__dirname, '..', 'connect.html'), path.join(DIR, 'connect.html'));
  for (const f of ['social.js', 'blue-tick.js', 'leaderboard.js']) {
    const fp = path.join(BACKEND, f);
    let c = fs.readFileSync(fp, 'utf8');
    c = c.split('0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F').join(reg.address);
    c = c.split('0x55d398326f99059fF775485246999027B3197955').join(usdt.address);
    fs.writeFileSync(fp, c);
  }
  // TEST-ONLY instrumentation (copy only, never the repo): log blue-tick
  // resolveHandle failures so a 403 no_agent_id can be diagnosed.
  {
    const fp = path.join(BACKEND, 'blue-tick.js');
    let c = fs.readFileSync(fp, 'utf8');
    c = c.replace('  } catch (e) {\n    /* RPC hiccup: treat as no handle this time */\n  }\n  return null;\n}',
      '  } catch (e) {\n    console.error("[bt-debug] resolveHandle failed for", address, "RPC", RPC_URL, "REGISTRY", REGISTRY, "err:", e && e.message);\n  }\n  return null;\n}');
    fs.writeFileSync(fp, c);
  }
  // Fixtures: social data for the leaderboard, vouchers, legacy record.
  const now = Date.now();
  const social = {
    messages: [
      { id: 1, address: buyerAddr, handle: 'buyerone.ai', room: 'social', text: 'a', ts: now - 1000 },
      { id: 2, address: buyerAddr, handle: 'buyerone.ai', room: 'social', text: 'b', ts: now - 900 },
      { id: 3, address: buyer2Addr, handle: 'buyertwo.ai', room: 'social', text: 'c', ts: now - 800 },
      { id: 4, address: buyer2Addr, handle: 'buyertwo.ai', room: 'group', text: 'group chat, must not count', ts: now - 700 },
    ],
    comments: [
      { id: 1, postId: 1, address: buyer2Addr, handle: 'buyertwo.ai', text: 'x', ts: now },
      { id: 2, postId: 1, address: buyer2Addr, handle: 'buyertwo.ai', text: 'y', ts: now },
    ],
    likes: [
      { messageId: 1, address: buyer2Addr }, { messageId: 1, address: buyer3Addr },
      { messageId: 3, address: buyerAddr },
    ],
    reposts: [{ messageId: 1, address: buyer3Addr, ts: now, handle: 'buyerthree.ai' }],
    follows: [
      { follower: buyer2Addr, following: buyerAddr },
      { follower: buyer3Addr, following: buyerAddr },
      { follower: buyerAddr, following: buyer2Addr },
    ],
    handles: { [buyerAddr.toLowerCase()]: 'buyerone.ai', [buyer2Addr.toLowerCase()]: 'buyertwo.ai' },
  };
  fs.writeFileSync(path.join(DIR, 'social.json'), JSON.stringify(social));
  fs.writeFileSync(path.join(DIR, 'vouchers.json'), JSON.stringify({ vouchers: {
    FREE1234: { code: 'FREE1234', kind: 'free', days: 365, discountPct: null, discountUsdt: null, maxUses: 10, usedCount: 0, usedBy: [], createdAt: now, note: 'e2e free', active: true },
    HALF50: { code: 'HALF50', kind: 'discount', days: 365, discountPct: 50, discountUsdt: null, maxUses: 10, usedCount: 0, usedBy: [], createdAt: now, note: 'e2e 50% off', active: true },
  }}));
  fs.writeFileSync(path.join(DIR, 'blue-tick.json'), JSON.stringify({
    'buyerthree.ai': { wallet: buyer3Addr, grantedAt: now - 10 * 86400 * 1000, expiresAt: now + 300 * 86400 * 1000, txHash: '0x' + 'ab'.repeat(32) },
  }));
  // first-seen > 24h for all handles (free-voucher anti-farm rule)
  fs.writeFileSync(path.join(DIR, 'blue-tick-first-seen.json'), JSON.stringify({
    'buyerone.ai': now - 30 * 86400 * 1000,
    'buyertwo.ai': now - 30 * 86400 * 1000,
    'buyerthree.ai': now - 30 * 86400 * 1000,
  }));

  // buyer4 (migration case): handle + funds + legacy record, all
  // seeded BEFORE the backend starts (stores load once at require).
  const buyer4 = walletAt(4);
  const buyer4Addr = await buyer4.getAddress();
  await reg.setHandle(buyer4Addr, 'buyerfour.ai');
  await usdt.mint(buyer4Addr, MINT_BAL);
  await usdt.connect(buyer4).approve(bt.address, ethers.constants.MaxUint256);
  const legacy4 = JSON.parse(fs.readFileSync(path.join(DIR, 'blue-tick.json'), 'utf8'));
  legacy4['buyerfour.ai'] = { wallet: buyer4Addr, grantedAt: now - 10 * 86400 * 1000, expiresAt: now + 200 * 86400 * 1000, txHash: '0x' + 'cd'.repeat(32) };
  fs.writeFileSync(path.join(DIR, 'blue-tick.json'), JSON.stringify(legacy4));
  const fs4 = JSON.parse(fs.readFileSync(path.join(DIR, 'blue-tick-first-seen.json'), 'utf8'));
  fs4['buyerfour.ai'] = now - 30 * 86400 * 1000;
  fs.writeFileSync(path.join(DIR, 'blue-tick-first-seen.json'), JSON.stringify(fs4));

  // ---------- start backend ----------
  const env = { ...process.env,
    PORT: String(PORT), HOST: '127.0.0.1',
    BSC_RPC_URL: 'http://127.0.0.1:8545',
    BLUE_TICK_NFT_ADDRESS: bt.address,
    BLUE_TICK_AUTHORIZER_KEY: authorizer.privateKey,
    BLUE_TICK_DATA: path.join(DIR, 'blue-tick.json'),
    VOUCHERS_DATA: path.join(DIR, 'vouchers.json'),
    BLUE_TICK_FIRST_SEEN: path.join(DIR, 'blue-tick-first-seen.json'),
    SOCIAL_DATA: path.join(DIR, 'social.json'),
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
    return { addr, session: ver.data.sessionId, expireAt: ver.data.expireAt };
  }

  try {
    // ---------- EIP-712 login ----------
    const ch0 = await j('POST', '/api/auth/challenge', { address: buyerAddr });
    ok('challenge issued', ch0.status === 200 && ch0.data.typedData && ch0.data.typedData.message.nonce);
    const { session: agentSession, expireAt: agentExp } = await loginAs(buyer);
    ok('EIP-712 login verifies', !!agentSession);
    ok('agent session is 48h', agentExp - Date.now() > 47 * 3600 * 1000 && agentExp - Date.now() <= 48 * 3600 * 1000 + 60000);
    const badSig = await j('POST', '/api/auth/verify', { address: buyerAddr, signature: '0x' + '11'.repeat(65) });
    ok('bad signature rejected (400 or 401)', badSig.status === 400 || badSig.status === 401);

    // ---------- connect link ----------
    const link = await j('POST', '/api/connect/link', { sessionId: agentSession });
    ok('connect link minted', link.status === 200 && link.data.ok && link.data.link.includes('/connect?token='));
    ok('link expires in ~10 min', link.data.expiresAt - Date.now() > 9 * 60 * 1000 && link.data.expiresAt - Date.now() <= 10 * 60 * 1000);
    const token = new URL(link.data.link).searchParams.get('token');
    const page = await fetch(BASE + '/connect?token=' + token);
    const pageText = await page.text();
    ok('GET /connect serves the page (200)', page.status === 200 && pageText.includes('Connecting your browser session'));
    ok('connect page has no code to scan or enter', !/qr|pairingCode|pair-qr|pair-code/i.test(pageText));
    const red = await j('POST', '/api/connect/redeem', { token });
    ok('token redeems to a browser session', red.status === 200 && red.data.ok && red.data.sessionId);
    ok('browser session is 7 days', red.data.expireAt - Date.now() > 6.99 * 24 * 3600 * 1000 && red.data.expireAt - Date.now() <= 7 * 24 * 3600 * 1000 + 60000);
    const browserSession = red.data.sessionId;
    const reuse = await j('POST', '/api/connect/redeem', { token });
    ok('token cannot be reused (410 already_used)', reuse.status === 410 && reuse.data.error === 'token_already_used');
    const badToken = await j('POST', '/api/connect/redeem', { token: '00'.repeat(32) });
    ok('unknown token rejected', badToken.status === 404);
    // Expired token: a second backend with a 100ms token TTL mints a
    // link, we wait it out, and the redeem must be rejected as expired.
    {
      const PORT2 = 3102;
      const BASE2 = `http://127.0.0.1:${PORT2}`;
      const child2 = spawn('node', ['server.js'], { cwd: BACKEND, env: { ...env, PORT: String(PORT2), CONNECT_TOKEN_TTL_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const j2 = async (method, pth, body) => {
        const r = await fetch(BASE2 + pth, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        let data = null; try { data = await r.json(); } catch (e) {}
        return { status: r.status, data };
      };
      let up = false;
      for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(BASE2 + '/api/health')).ok; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
      try {
        ok('short-TTL backend starts', up);
        const chX = await j2('POST', '/api/auth/challenge', { address: buyerAddr });
        const tdX = chX.data.typedData;
        const sigX = await buyer._signTypedData(tdX.domain, tdX.types, tdX.message);
        const verX = await j2('POST', '/api/auth/verify', { address: buyerAddr, signature: sigX });
        const linkX = await j2('POST', '/api/connect/link', { sessionId: verX.data.sessionId });
        const tokenX = new URL(linkX.data.link).searchParams.get('token');
        await new Promise(r => setTimeout(r, 300));
        const exp = await j2('POST', '/api/connect/redeem', { token: tokenX });
        ok('expired token rejected (410 token_expired)', exp.status === 410 && exp.data.error === 'token_expired');
      } finally {
        child2.kill('SIGTERM');
      }
    }

    // ---------- session status / disconnect ----------
    const st = await j('GET', `/api/session/status/${browserSession}`);
    ok('session status reports ACTIVE + address + 7d expiry', st.status === 200 && st.data.status === 'ACTIVE' && st.data.address === buyerAddr.toLowerCase());
    const dc = await j('POST', `/api/session/disconnect/${browserSession}`, {});
    ok('disconnect ok', dc.status === 200 && dc.data.ok);
    const st2 = await j('GET', `/api/session/status/${browserSession}`);
    ok('disconnected session is gone (404)', st2.status === 404);

    // ---------- leaderboard ----------
    // Expected: buyerone: posts 2, likesReceived 2 (msg1 x2), repostsReceived 1, followers 2 => 2+0+4+3+4 = 13
    // buyertwo: posts 1 (group msg excluded), comments 2, likesReceived 1, repostsReceived 0, followers 1 => 1+2+2+0+2 = 7
    // buyerthree: no posts/comments, only gave like/repost/follow => score 0, excluded.
    const lb = await j('GET', '/api/leaderboard');
    ok('leaderboard returns 2 ranked rows', lb.status === 200 && lb.data.ok && lb.data.leaderboard.length === 2);
    const [r1, r2] = lb.data.leaderboard;
    ok('rank 1 is buyerone.ai with score 13', r1 && r1.handle === 'buyerone.ai' && r1.score === 13 && r1.posts === 2 && r1.likesReceived === 2 && r1.repostsReceived === 1 && r1.followers === 2);
    ok('rank 2 is buyertwo.ai with score 7', r2 && r2.handle === 'buyertwo.ai' && r2.score === 7 && r2.posts === 1 && r2.comments === 2 && r2.likesReceived === 1 && r2.followers === 1);
    ok('group message did not count', r2.posts === 1);
    ok('on-chain stats report live BSC contract when deployed', lb.data.onChain && lb.data.onChain.deployed === true && lb.data.onChain.contract === bt.address);
    ok('rank 1 blueTick false before mint', r1.blueTick === false);

    // ---------- On-chain .ai Check-In + confirm + stats + leaderboard boost ----------
    const ciTx = await bt.connect(buyer).checkIn('gm hackathon');
    const ciRc = await ciTx.wait();
    const ciConf = await j('POST', '/api/onchain/checkin/confirm', { sessionId: agentSession, txHash: ciRc.transactionHash });
    ok('on-chain .ai check-in confirm succeeds (streak 1)', ciConf.status === 200 && ciConf.data.ok && ciConf.data.totalCount === 1 && ciConf.data.streak === 1);
    const ocStats = await j('GET', '/api/onchain/stats');
    ok('/api/onchain/stats reports 1 check-in and 1 unique .ai agent', ocStats.status === 200 && ocStats.data.deployed === true && ocStats.data.totalCheckIns === 1 && ocStats.data.uniqueAgents === 1);
    const lbAfterCi = await j('GET', '/api/leaderboard');
    const r1Ci = lbAfterCi.data.leaderboard[0];
    ok('on-chain check-in adds +3 score on leaderboard (13 -> 16)', r1Ci && r1Ci.handle === 'buyerone.ai' && r1Ci.score === 16 && r1Ci.onChainCheckIns === 1 && r1Ci.streak === 1);

    // ---------- Blue Tick quote / status ----------
    const q = await j('GET', '/api/bluetick/quote');
    ok('quote: deployed, $5 (18 dec), .ai only, treasury, nft address', q.status === 200 && q.data.deployed === true && q.data.agentIdOnly === true && q.data.usdtDecimals === 18 && q.data.priceBaseUnits === '5000000000000000000' && q.data.nftAddress === bt.address);
    const stB = await j('GET', `/api/bluetick/status/${buyerAddr}`);
    ok('buyer status unverified before mint', stB.status === 200 && stB.data.verified === false);

    // ---------- social write gate: 600 chars without a tick -> 400 ----------
    const long600 = 'x'.repeat(600);
    const postNoTick = await j('POST', '/api/social/messages', { sessionId: agentSession, text: long600 });
    ok('600-char post rejected without a tick', postNoTick.status === 400);

    // ---------- plain buy + confirm ----------
    let tx = await bt.connect(buyer).buy(PRICE, 365, '', 0, 0, '0x');
    const rc = await tx.wait();
    const conf = await j('POST', '/api/bluetick/confirm', { sessionId: agentSession, txHash: rc.transactionHash });
    ok('confirm verifies the mint receipt', conf.status === 200 && conf.data.ok && conf.data.verified === true && conf.data.source === 'nft' && conf.data.kind === 'buy');
    const stB2 = await j('GET', `/api/bluetick/status/${buyerAddr}`);
    ok('buyer status verified after mint (source nft)', stB2.data.verified === true && stB2.data.source === 'nft' && stB2.data.tokenId === '1');
    const postTick = await j('POST', '/api/social/messages', { sessionId: agentSession, text: long600 });
    ok('600-char post allowed with an active tick', postTick.status === 200 && postTick.data.message && postTick.data.message.text.length === 600);

    // NOTE: voucher buys run BEFORE the 366-day time travel below:
    // the authorizations carry a 10-minute deadline against block
    // time, so after evm_increaseTime(+366d) every fresh auth would
    // be instantly expired on chain ("auth expired").

    // ---------- discount voucher authorize -> on-chain buy ----------
    const { session: sess2 } = await loginAs(buyer2);
    const auth = await j('POST', '/api/bluetick/voucher/authorize', { sessionId: sess2, code: 'HALF50' });
    if (auth.status !== 200) console.log('AUTHORIZE DEBUG:', auth.status, JSON.stringify(auth.data));
    ok('discount voucher authorizes 2.5 USDT (18 decimals)', auth.status === 200 && auth.data.ok && auth.data.amount === '2500000000000000000' && auth.data.durationDays === 365 && auth.data.auth);
    const auth2 = await j('POST', '/api/bluetick/voucher/authorize', { sessionId: sess2, code: 'HALF50' });
    ok('second authorize for same code is reserved (409)', auth2.status === 409 && auth2.data.error === 'voucher_reserved');
    // Execute the authorized buy on chain (proves the EIP-712 auth is valid).
    tx = await bt.connect(buyer2).buy(auth.data.amount, auth.data.durationDays, 'HALF50', auth.data.deadline, auth.data.nonce, auth.data.auth);
    const rc2 = await tx.wait();
    const conf2 = await j('POST', '/api/bluetick/confirm', { sessionId: sess2, txHash: rc2.transactionHash });
    ok('discount mint confirms and verifies', conf2.status === 200 && conf2.data.verified === true);
    const vouchersAfter = JSON.parse(fs.readFileSync(path.join(DIR, 'vouchers.json'), 'utf8'));
    ok('discount voucher marked used once', vouchersAfter.vouchers.HALF50.usedCount === 1 && vouchersAfter.vouchers.HALF50.usedBy.includes('buyertwo.ai'));

    // ---------- free voucher redeem (deployed: returns mint auth) ----------
    const { session: sess3 } = await loginAs(buyer3);
    const free = await j('POST', '/api/bluetick/voucher/redeem', { sessionId: sess3, code: 'FREE1234' });
    ok('free voucher redeem returns mint auth (amount "0")', free.status === 200 && free.data.ok && free.data.needsMint === true && free.data.amount === '0');
    tx = await bt.connect(buyer3).buy(0, free.data.durationDays, 'FREE1234', free.data.deadline, free.data.nonce, free.data.auth);
    const rc3 = await tx.wait();
    const conf3 = await j('POST', '/api/bluetick/confirm', { sessionId: sess3, txHash: rc3.transactionHash });
    ok('free voucher mint confirms', conf3.status === 200 && conf3.data.verified === true);

    // ---------- legacy migration ----------
    const { session: sess4 } = await loginAs(buyer4);
    const mig = await j('POST', '/api/bluetick/migrate', { sessionId: sess4 });
    ok('migration issues a free mint auth for remaining days', mig.status === 200 && mig.data.ok && mig.data.amount === '0' && mig.data.durationDays >= 199 && mig.data.durationDays <= 200);
    tx = await bt.connect(buyer4).buy(0, mig.data.durationDays, '', mig.data.deadline, mig.data.nonce, mig.data.auth);
    const rc4 = await tx.wait();
    const conf4 = await j('POST', '/api/bluetick/confirm', { sessionId: sess4, txHash: rc4.transactionHash });
    ok('migrated mint confirms', conf4.status === 200 && conf4.data.verified === true && conf4.data.source === 'nft');
    const migAgain = await j('POST', '/api/bluetick/migrate', { sessionId: sess4 });
    ok('second migration rejected (already owns)', migAgain.status === 409);

    // ---------- claim is NFT-only once deployed ----------
    const claim = await j('POST', '/api/bluetick/claim', { sessionId: agentSession, txHash: '0x' + '00'.repeat(32) });
    ok('legacy claim returns 410 use_nft_purchase when deployed', claim.status === 410 && claim.data.error === 'use_nft_purchase');

    // ---------- voucher preview (public) ----------
    const prev = await j('GET', '/api/bluetick/voucher/HALF50');
    ok('public voucher preview shows terms, no internals', prev.status === 200 && prev.data.voucher.discountLabel === '50% OFF' && prev.data.voucher.discountedPriceUsdt === 2.5 && !('usedBy' in prev.data.voucher));

    // ---------- expiry: advance 366 days, tick stops working ----------
    await provider.send('evm_increaseTime', [366 * 86400]);
    await provider.send('evm_mine');
    // The verification cache lives 60s; wait it out so the expiry
    // check reads fresh on-chain state, not the pre-expiry cache.
    await new Promise(r => setTimeout(r, 61000));
    const stExp = await j('GET', `/api/bluetick/status/${buyerAddr}`);
    ok('expired token gives no benefit', stExp.data.verified === false);
    const postExp = await j('POST', '/api/social/messages', { sessionId: agentSession, text: long600 });
    ok('600-char post rejected after expiry', postExp.status === 400);

    // ---------- renew the SAME token, no new mint ----------
    const nextBeforeRenew = await bt.nextTokenId();
    tx = await bt.connect(buyer).renew(1, PRICE, 365, '', 0, 0, '0x');
    const rcR = await tx.wait();
    const confR = await j('POST', '/api/bluetick/confirm', { sessionId: agentSession, txHash: rcR.transactionHash });
    ok('confirm verifies the renew receipt', confR.status === 200 && confR.data.ok && confR.data.kind === 'renew' && confR.data.tokenId === '1');
    const stRen = await j('GET', `/api/bluetick/status/${buyerAddr}`);
    ok('benefit active again after renew', stRen.data.verified === true);
    ok('no second token minted on renew', (await bt.nextTokenId()).toNumber() === nextBeforeRenew.toNumber());

  } finally {
    child.kill('SIGTERM');
    await ganacheServer.close();
  }
  console.log(`\nE2E RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
