// BlueTickNFT contract tests on a local ganache (BSC chainId 56).
// Covers: 18-decimal BSC USDT (5 ether), strict .ai-only on-chain gate
// (non-.ai reverts on buy / renew / checkIn), soulbound transfers, expiry,
// same-token renew, free & discount vouchers, bad auth / replay / deadline,
// on-chain .ai Check-In (cooldown, streak increment & reset, note length,
// uniqueAgents, getAgentStats, getProtocolStats), and .ai tokenURI JSON.
// Run: npm run compile && npm run test:contract   (from this dir)
const ganache = require('ganache');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const BT = JSON.parse(fs.readFileSync(path.join(__dirname, 'artifacts', 'BlueTickNFT.json'), 'utf8'));
const MOCKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'artifacts', 'mocks.json'), 'utf8'));
const PRICE = ethers.utils.parseUnits('5', 18); // 5 USDT, 18 decimals on BSC
const HALF_PRICE = ethers.utils.parseUnits('2.5', 18); // 2.5 USDT, 18 decimals
const MINT_BAL = ethers.utils.parseUnits('100', 18);
const DAY = 86400;
const HOUR = 3600;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name, extra || ''); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
async function reverts(p, name) {
  try { await p; ok(name, false, '(did not revert)'); }
  catch (e) { ok(name, /revert|call revert|VM Exception|missing revert/i.test(e.message), '(' + String(e.message).slice(0, 80) + ')'); }
}

(async () => {
  const provider = new ethers.providers.Web3Provider(ganache.provider({ logging: { quiet: true }, chain: { chainId: 56 } }));
  const [deployer, buyer, buyer2, noAiUser, buyer3] = [0, 1, 2, 3, 4].map(i => provider.getSigner(i));
  const deployerAddr = await deployer.getAddress();
  const buyerAddr = await buyer.getAddress();
  const buyer2Addr = await buyer2.getAddress();
  const noAiAddr = await noAiUser.getAddress();
  const buyer3Addr = await buyer3.getAddress();
  const authorizer = ethers.Wallet.createRandom().connect(provider);
  const authorizerAddr = await authorizer.getAddress();

  const usdt = await new ethers.ContractFactory(MOCKS.MockUSDT.abi, MOCKS.MockUSDT.bytecode, deployer).deploy();
  const reg = await new ethers.ContractFactory(MOCKS.MockRegistry.abi, MOCKS.MockRegistry.bytecode, deployer).deploy();
  const bt = await new ethers.ContractFactory(BT.abi, BT.bytecode, deployer).deploy(
    usdt.address, deployerAddr, authorizerAddr, reg.address
  );

  ok('MockUSDT has 18 decimals (matches BSC USDT)', (await usdt.decimals()) === 18);
  ok('PRICE constant is 5e18 (5 USDT BSC)', (await bt.PRICE()).eq(PRICE));

  // Assign .ai Agent IDs to buyer, buyer2, buyer3 (NOT to noAiUser!)
  await reg.setHandle(buyerAddr, 'buyerone'); // mainnet style (no .ai suffix)
  await reg.setHandle(buyer2Addr, 'buyertwo.ai'); // suffix style
  await reg.setHandle(buyer3Addr, 'buyerthree');

  for (const s of [buyer, buyer2, noAiUser, buyer3]) {
    const a = await s.getAddress();
    await usdt.mint(a, MINT_BAL);
    await usdt.connect(s).approve(bt.address, ethers.constants.MaxUint256);
  }

  // 0. Strict .ai-only gate BEFORE anything else
  await reverts(bt.connect(noAiUser).buy(PRICE, 365, '', 0, 0, '0x').then(t => t.wait()), 'non-.ai wallet reverts on buy');
  await reverts(bt.connect(noAiUser).checkIn('hi').then(t => t.wait()), 'non-.ai wallet reverts on checkIn');
  ok('hasAgentId false for non-.ai wallet', !(await bt.hasAgentId(noAiAddr)));
  ok('hasAgentId true for .ai wallet', await bt.hasAgentId(buyerAddr));

  // 1. Plain buy, full price (5 USDT, 18 decimals)
  let tx = await bt.connect(buyer).buy(PRICE, 365, '', 0, 0, '0x');
  let rc = await tx.wait();
  const minted = rc.events.find(e => e.event === 'BlueTickMinted');
  const tid = minted.args.tokenId;
  ok('plain buy mints tokenId 1 with handle', tid.eq(1) && minted.args.handle === 'buyerone');
  ok('isActive true after buy', await bt.isActive(tid));
  ok('isVerifiedAgent true after buy', await bt.isVerifiedAgent(buyerAddr));
  ok('activeBalanceOf 1 after buy', (await bt.activeBalanceOf(buyerAddr)).eq(1));
  ok('balanceOf 1 after buy', (await bt.balanceOf(buyerAddr)).eq(1));
  ok('tokenOf maps wallet', (await bt.tokenOf(buyerAddr)).eq(tid));
  ok('treasury received exact 5e18 USDT', (await usdt.balanceOf(deployerAddr)).eq(PRICE));
  const uri = await bt.tokenURI(tid);
  const meta = JSON.parse(uri.replace('data:application/json,', ''));
  ok('tokenURI embeds formatted .ai handle in valid JSON', meta.handle === 'buyerone.ai' && meta.expiresAt > 0);
  const exp1 = await bt.expiresAt(tid);

  // 2. Second buy reverts (one per wallet)
  await reverts(bt.connect(buyer).buy(PRICE, 365, '', 0, 0, '0x').then(t => t.wait()), 'second buy reverts');

  // 3. Soulbound: transfer & approve revert
  await reverts(bt.connect(buyer).transferFrom(buyerAddr, noAiAddr, tid).then(t => t.wait()), 'transferFrom reverts (soulbound)');
  await reverts(bt.connect(buyer).approve(noAiAddr, tid).then(t => t.wait()), 'approve reverts (soulbound)');

  // 4. On-chain .ai Check-In (gas-only, cooldown, streaks, protocol stats)
  tx = await bt.connect(buyer).checkIn('gm from buyerone.ai');
  rc = await tx.wait();
  const ciEvt = rc.events.find(e => e.event === 'AgentCheckedIn');
  ok('checkIn emits AgentCheckedIn with streak 1', !!ciEvt && ciEvt.args.handle === 'buyerone' && ciEvt.args.streak.eq(1) && ciEvt.args.totalCount.eq(1));
  await reverts(bt.connect(buyer).checkIn('spam').then(t => t.wait()), 'repeat checkIn within 20h cooldown reverts');
  await reverts(bt.connect(buyer2).checkIn('x'.repeat(141)).then(t => t.wait()), 'checkIn note > 140 bytes reverts');
  await bt.connect(buyer2).checkIn('hello bsc').then(t => t.wait());
  const pstats = await bt.getProtocolStats();
  ok('getProtocolStats tracks 1 BlueTick, 2 checkIns, 2 uniqueAgents', pstats.totalBlueTicks.eq(1) && pstats.totalCheckIns_.eq(2) && pstats.uniqueCheckInAgents.eq(2));

  // Advance 24h -> streak increments to 2
  await provider.send('evm_increaseTime', [24 * HOUR]);
  await provider.send('evm_mine');
  await bt.connect(buyer).checkIn('day 2').then(t => t.wait());
  const st2 = await bt.getAgentStats(buyerAddr);
  ok('checkIn after 24h increments streak to 2', st2.checkIns.eq(2) && st2.streak.eq(2) && st2.hasActiveBlueTick === true);

  // Advance 72h (> 48h window) -> streak resets to 1, count becomes 3
  await provider.send('evm_increaseTime', [72 * HOUR]);
  await provider.send('evm_mine');
  await bt.connect(buyer).checkIn('back again').then(t => t.wait());
  const st3 = await bt.getAgentStats(buyerAddr);
  ok('checkIn after 72h resets streak to 1 and increments count to 3', st3.checkIns.eq(3) && st3.streak.eq(1));

  // 5. Voucher path BEFORE 366d time-travel
  const domain = { name: 'Agentics Blue Tick', version: '1', chainId: 56, verifyingContract: bt.address };
  const types = { Purchase: [
    { name: 'buyer', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'durationDays', type: 'uint256' }, { name: 'voucherCodeHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' } ] };
  async function signAuth(buyerAddr_, amount, durationDays, code, deadline, nonce) {
    const value = { buyer: buyerAddr_, amount, durationDays,
      voucherCodeHash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(code)), deadline, nonce };
    return authorizer._signTypedData(domain, types, value);
  }
  const block = await provider.getBlock('latest');
  const deadline = block.timestamp + 600;
  const authFree = await signAuth(buyer2Addr, 0, 365, 'FREECODE1', deadline, 1);
  tx = await bt.connect(buyer2).buy(0, 365, 'FREECODE1', deadline, 1, authFree);
  rc = await tx.wait();
  const tid2 = rc.events.find(e => e.event === 'BlueTickMinted').args.tokenId;
  ok('free-voucher mint (amount 0) works for .ai holder', tid2.eq(2) && (await bt.isActive(tid2)));
  const uri2 = await bt.tokenURI(tid2);
  const meta2 = JSON.parse(uri2.replace('data:application/json,', ''));
  ok('tokenURI does not double-append .ai suffix', meta2.handle === 'buyertwo.ai');

  // Discount mint at 2.5 USDT (18 decimals)
  const authDisc = await signAuth(buyer3Addr, HALF_PRICE, 365, 'HALF50', deadline, 2);
  await bt.connect(buyer3).buy(HALF_PRICE, 365, 'HALF50', deadline, 2, authDisc).then(t => t.wait());
  ok('discount mint at 2.5e18 USDT works', (await bt.activeBalanceOf(buyer3Addr)).eq(1));
  ok('treasury balance equals 7.5e18 USDT', (await usdt.balanceOf(deployerAddr)).eq(PRICE.add(HALF_PRICE)));

  // Bad auth / replay / expired deadline revert
  await reverts(bt.connect(noAiUser).buy(0, 365, 'FREECODE1', deadline, 3, authFree).then(t => t.wait()), 'auth + non-.ai reverts');
  await reverts(bt.connect(buyer2).buy(0, 365, 'FREECODE1', deadline, 1, authFree).then(t => t.wait()), 'replayed nonce reverts');
  const pastDeadline = block.timestamp - 10;
  const authLate = await signAuth(buyer3Addr, 0, 365, 'LATE', pastDeadline, 9);
  await reverts(bt.connect(buyer3).renew(3, 0, 365, 'LATE', pastDeadline, 9, authLate).then(t => t.wait()), 'expired deadline reverts');

  // 6. Expiry: advance 366 days
  await provider.send('evm_increaseTime', [366 * DAY]);
  await provider.send('evm_mine');
  ok('isActive false after expiry', !(await bt.isActive(tid)));
  ok('isExpired true after expiry', await bt.isExpired(tid));
  ok('activeBalanceOf 0 after expiry', (await bt.activeBalanceOf(buyerAddr)).eq(0));
  ok('balanceOf still 1 after expiry (token not burned)', (await bt.balanceOf(buyerAddr)).eq(1));

  // 7. Renew expired token: same tokenId, no new mint
  const beforeCount = (await bt.nextTokenId()).toNumber();
  tx = await bt.connect(buyer).renew(tid, PRICE, 365, '', 0, 0, '0x');
  rc = await tx.wait();
  ok('renew emits BlueTickRenewed', !!rc.events.find(e => e.event === 'BlueTickRenewed'));
  ok('isActive true after renew', await bt.isActive(tid));
  ok('no new token minted on renew', (await bt.nextTokenId()).toNumber() === beforeCount);
  const exp2 = await bt.expiresAt(tid);
  ok('expiry extended ~365d from renew', exp2.sub(exp1).gt(360 * DAY));

  // 8. Renew while active extends from OLD expiry
  const expBefore = await bt.expiresAt(tid);
  await bt.connect(buyer).renew(tid, PRICE, 365, '', 0, 0, '0x').then(t => t.wait());
  const expAfter = await bt.expiresAt(tid);
  ok('active renew extends from old expiry', expAfter.sub(expBefore).eq(365 * DAY));

  // 9. Non-owner renew reverts, AND owner without .ai reverts on renew
  await reverts(bt.connect(buyer2).renew(tid, PRICE, 365, '', 0, 0, '0x').then(t => t.wait()), 'non-owner renew reverts');
  await reg.setHandle(buyerAddr, '');
  ok('isVerifiedAgent becomes false if .ai handle removed', !(await bt.isVerifiedAgent(buyerAddr)));
  await reverts(bt.connect(buyer).renew(tid, PRICE, 365, '', 0, 0, '0x').then(t => t.wait()), 'owner without .ai reverts on renew');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
