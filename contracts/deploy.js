// Manual operator deploy script for BlueTickNFT (.ai-only, 18-decimal BSC USDT).
// NEVER runs automatically. Requires explicit operator gas approval & env vars:
//   DEPLOYER_PRIVATE_KEY=0x...
//   BLUE_TICK_AUTHORIZER_ADDRESS=0x...
//   BSC_RPC_URL=https://bsc-dataseed.bnbchain.org   (optional)
//
// Usage:
//   cd test && npm run compile
//   DEPLOYER_PRIVATE_KEY=0x... BLUE_TICK_AUTHORIZER_ADDRESS=0x... node ../contracts/deploy.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("../backend/node_modules/ethers");

const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955"; // 18 decimals
const TREASURY = "0x0a398d602D56318F6342586e77299Cd0bF9C523b";
const AGENT_ID_REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F"; // SPACE ID .ai registry

(async () => {
  const pk = (process.env.DEPLOYER_PRIVATE_KEY || "").trim();
  const authorizer = (process.env.BLUE_TICK_AUTHORIZER_ADDRESS || "").trim();
  const rpcUrl = process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";

  if (!pk || !ethers.utils.isAddress(authorizer)) {
    console.error("Missing DEPLOYER_PRIVATE_KEY or valid BLUE_TICK_AUTHORIZER_ADDRESS");
    process.exit(1);
  }
  const artPath = path.join(__dirname, "..", "test", "artifacts", "BlueTickNFT.json");
  if (!fs.existsSync(artPath)) {
    console.error("Compiled artifact not found. Run `cd test && npm run compile` first.");
    process.exit(1);
  }
  const art = JSON.parse(fs.readFileSync(artPath, "utf8"));
  const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, 56);
  const wallet = new ethers.Wallet(pk, provider);
  const bal = await provider.getBalance(wallet.address);

  console.log("Deployer:         ", wallet.address);
  console.log("BNB Balance:      ", ethers.utils.formatEther(bal), "BNB");
  console.log("USDT (18 dec):    ", USDT_BSC);
  console.log("Treasury:         ", TREASURY);
  console.log("Authorizer:       ", authorizer);
  console.log("Agent ID Registry:", AGENT_ID_REGISTRY);

  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  const contract = await factory.deploy(USDT_BSC, TREASURY, authorizer, AGENT_ID_REGISTRY);
  console.log("Deploy tx sent:   ", contract.deployTransaction.hash);
  await contract.deployed();

  console.log("\n=== DEPLOYED ===");
  console.log("BLUE_TICK_NFT_ADDRESS=" + contract.address);
  console.log("BscScan URL: https://bscscan.com/address/" + contract.address);
  console.log("\nBscScan Verify Settings:");
  console.log("  Compiler:   v0.8.26+commit.8a97fa7a");
  console.log("  Optimizer:  Enabled, 200 runs");
  console.log("  EVM Target: shanghai");
  console.log("  Args:      ", JSON.stringify([USDT_BSC, TREASURY, authorizer, AGENT_ID_REGISTRY]));
  console.log(
    "  ABI-Encoded Constructor Args:",
    ethers.utils.defaultAbiCoder
      .encode(["address", "address", "address", "address"], [USDT_BSC, TREASURY, authorizer, AGENT_ID_REGISTRY])
      .slice(2)
  );
})().catch((e) => {
  console.error("DEPLOY FAILED:", e);
  process.exit(1);
});
