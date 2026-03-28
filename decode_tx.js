require("dotenv").config();
const { ethers } = require("ethers");

const RPC = process.env.RPC_PRIMARY || process.env.RPC_BACKUP;
const CHAIN_ID = Number(process.env.CHAIN_ID || 369);

const TX_HASH = "0x2e64b6398f6db1609087b6c9ab6ba64733967a6cd58f3743b214b9b4db904c34";

// ERC20 Transfer topic
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

function short(a) {
  if (!a) return "—";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC, { chainId: CHAIN_ID, name: "pulsechain" }, { staticNetwork: true });

  const tx = await provider.getTransaction(TX_HASH);
  if (!tx) throw new Error("Tx not found (wrong hash or RPC issue)");

  const receipt = await provider.getTransactionReceipt(TX_HASH);
  if (!receipt) throw new Error("Receipt not found yet (tx may be pending)");

  console.log("\n=== TX ===");
  console.log("hash:", tx.hash);
  console.log("from:", tx.from);
  console.log("to  :", tx.to);
  console.log("value (PLS):", ethers.formatEther(tx.value || 0n));
  console.log("selector:", (tx.data || "").slice(0, 10));
  console.log("data len:", (tx.data || "").length);
console.log("data:", tx.data);

const data = tx.data;
if (data && data.length === 138) {
  const arg1 = "0x" + data.slice(10, 74);
  const arg2 = "0x" + data.slice(74, 138);

  console.log("\n=== RAW ARGS ===");
  console.log("arg1:", arg1);
  console.log("arg2:", arg2);

  // Try interpret arg1 as address
  const addrCandidate = "0x" + arg1.slice(26);
  try {
    console.log("arg1 as address:", ethers.getAddress(addrCandidate));
  } catch {
    console.log("arg1 as address: (not valid)");
  }

  console.log("arg2 as uint:", BigInt(arg2).toString());
}

  console.log("\n=== RECEIPT ===");
  console.log("status:", receipt.status);
  console.log("block:", receipt.blockNumber);
  console.log("gasUsed:", receipt.gasUsed?.toString());
  console.log("effGasPrice (gwei):", receipt.effectiveGasPrice ? ethers.formatUnits(receipt.effectiveGasPrice, "gwei") : "—");

  const gasPaidWei = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n);
  console.log("gasPaid (PLS):", ethers.formatEther(gasPaidWei));

  console.log("\n=== TRANSFERS (ERC20 logs) ===");
  let i = 0;
  for (const log of receipt.logs) {
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;

    const from = ethers.getAddress("0x" + log.topics[1].slice(26));
    const to = ethers.getAddress("0x" + log.topics[2].slice(26));
    const amount = BigInt(log.data);

    console.log(`\n[${i++}] tokenContract: ${log.address}`);
    console.log("  from:", short(from), from);
    console.log("  to  :", short(to), to);
    console.log("  raw :", amount.toString());
  }

  console.log("\nDone.\n");
})().catch((e) => {
  console.error("Decode error:", e?.message || e);
  process.exit(1);
});
