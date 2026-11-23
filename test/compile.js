// Compile contracts/BlueTickNFT.sol + the test mocks with solc 0.8.26
// (OpenZeppelin 5.0.2 from this dir's node_modules).
// Writes artifacts/BlueTickNFT.json and artifacts/mocks.json.
// Run: npm run compile   (from this dir)
const solc = require('solc');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ART = path.join(__dirname, 'artifacts');
fs.mkdirSync(ART, { recursive: true });

function findImports(p) {
  if (p.startsWith('@openzeppelin/')) {
    return { contents: fs.readFileSync(path.join(__dirname, 'node_modules', p), 'utf8') };
  }
  return { error: 'not found: ' + p };
}
function compile(sources) {
  // evmVersion pinned to Shanghai: solc 0.8.26 defaults to Cancun
  // (MCOPY/TSTORE), which this ganache (7.9.2) does not execute —
  // a string-returning getter reverted with "invalid opcode" on the
  // default Cancun target. Shanghai bytecode runs on BSC mainnet
  // (Cancun is a superset there), and the artifact tested here is
  // the artifact deployed, so the pin stays in the deploy docs too.
  const input = { language: 'Solidity', sources,
    settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errs = (out.errors || []).filter(e => e.severity === 'error');
  if (errs.length) { console.error(JSON.stringify(errs, null, 2)); process.exit(1); }
  for (const w of (out.errors || []).filter(e => e.severity === 'warning')) console.warn('warning:', w.message);
  return out.contracts;
}

const bt = compile({ 'BlueTickNFT.sol': { content: fs.readFileSync(path.join(ROOT, 'contracts', 'BlueTickNFT.sol'), 'utf8') } });
const c = bt['BlueTickNFT.sol']['BlueTickNFT'];
fs.writeFileSync(path.join(ART, 'BlueTickNFT.json'), JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }));
console.log('BlueTickNFT: ABI entries', c.abi.length, '| bytecode bytes', c.evm.bytecode.object.length / 2);

const mocks = compile({
  'MockUSDT.sol': { content: fs.readFileSync(path.join(__dirname, 'MockUSDT.sol'), 'utf8') },
  'MockRegistry.sol': { content: fs.readFileSync(path.join(__dirname, 'MockRegistry.sol'), 'utf8') },
});
const artifacts = {};
for (const contracts of Object.values(mocks)) {
  for (const [name, cc] of Object.entries(contracts)) artifacts[name] = { abi: cc.abi, bytecode: '0x' + cc.evm.bytecode.object };
}
fs.writeFileSync(path.join(ART, 'mocks.json'), JSON.stringify(artifacts));
console.log('mocks compiled:', Object.keys(artifacts).join(', '));
console.log('solc version:', solc.version());
