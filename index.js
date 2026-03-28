require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");
const { ethers } = require("ethers");

/* ===================== ENV ===================== */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_PRIMARY = process.env.RPC_PRIMARY;
const RPC_BACKUP = process.env.RPC_BACKUP;
const CHAIN_ID = Number(process.env.CHAIN_ID || 369);
const PULSEX_ROUTER = process.env.PULSEX_ROUTER;
const WPLS = process.env.WPLS;
const OWNER_ID = Number(process.env.OWNER_ID);

if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in .env");
if (!RPC_PRIMARY) throw new Error("Missing RPC_PRIMARY in .env");
if (!RPC_BACKUP) throw new Error("Missing RPC_BACKUP in .env");
if (!PULSEX_ROUTER) throw new Error("Missing PULSEX_ROUTER in .env");
if (!WPLS) throw new Error("Missing WPLS in .env");
if (!OWNER_ID) throw new Error("Missing OWNER_ID in .env");

/* ===================== PROVIDERS / WALLETS ===================== */
/**
 * Provide Networkish so ethers doesn't spam detectNetwork on flaky RPCs.
 * (No need for options; keep compatible with ethers v6.)
 */
const NETWORK = { chainId: CHAIN_ID, name: "pulsechain" };

const providerPrimary = new ethers.JsonRpcProvider(RPC_PRIMARY, NETWORK);
const providerBackup = new ethers.JsonRpcProvider(RPC_BACKUP, NETWORK);

const walletPrimary = new ethers.Wallet(PRIVATE_KEY, providerPrimary);
const walletBackup = new ethers.Wallet(PRIVATE_KEY, providerBackup);

let rpcState = { active: "Primary", msPrimary: null, msBackup: null };

async function withTimeout(p, ms, fallback = null) {
  let t;
  return await Promise.race([
    p,
    new Promise((resolve) => {
      t = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

async function pingRpc(provider) {
  const t0 = Date.now();
  const bn = await withTimeout(provider.getBlockNumber(), 2000, null);
  if (bn == null) throw new Error("PING_TIMEOUT");
  return Date.now() - t0;
}

// sanity-check fee fields so a "fast but broken" RPC doesn't get selected
async function feeSanity(provider) {
  const block = await withTimeout(provider.getBlock("latest"), 1500, null);
  const base = block?.baseFeePerGas ?? null;
  if (base == null) return false;
  const baseGwei = Number(ethers.formatUnits(base, "gwei"));
  if (!Number.isFinite(baseGwei)) return false;

  // PulseChain should not be 100k+ gwei base fee. Keep a generous cap.
  return baseGwei >= 0 && baseGwei < 5000;
}

async function refreshFastestRpc() {
  const [a, b] = await Promise.allSettled([
    (async () => ({ ms: await pingRpc(providerPrimary), ok: await feeSanity(providerPrimary) }))(),
    (async () => ({ ms: await pingRpc(providerBackup), ok: await feeSanity(providerBackup) }))(),
  ]);

  const ra = a.status === "fulfilled" ? a.value : { ms: null, ok: false };
  const rb = b.status === "fulfilled" ? b.value : { ms: null, ok: false };

  rpcState.msPrimary = ra.ok ? ra.ms : null;
  rpcState.msBackup = rb.ok ? rb.ms : null;

  // If both fail sanity, fall back to whichever at least pings
  if (rpcState.msPrimary == null && rpcState.msBackup == null) {
    const pa = a.status === "fulfilled" ? ra.ms : null;
    const pb = b.status === "fulfilled" ? rb.ms : null;
    if (pa != null && pb != null) rpcState.active = pa <= pb ? "Primary" : "Backup";
    else if (pa != null) rpcState.active = "Primary";
    else if (pb != null) rpcState.active = "Backup";
    return rpcState;
  }

  // Slight bias toward Backup unless Primary is meaningfully faster
  if (rpcState.msBackup != null && rpcState.msPrimary != null) {
    rpcState.active = (rpcState.msPrimary + 50) < rpcState.msBackup ? "Primary" : "Backup";
  } else if (rpcState.msPrimary != null) {
    rpcState.active = "Primary";
  } else {
    rpcState.active = "Backup";
  }

  return rpcState;
}

/**
 * Reads can rotate (fastest sane).
 * Sends MUST be reliable & propagate -> always broadcast via Backup (publicnode).
 */
function readProvider() {
  return rpcState.active === "Backup" ? providerBackup : providerPrimary;
}
function sendWallet() {
  return walletBackup;
}

/* ===================== ABIs ===================== */
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
];

/* ===================== HELPERS ===================== */
function isAddr(a) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(a || ""));
}
function normAddr(a) {
  return ethers.getAddress(a);
}
function nowPlus(min) {
  return Math.floor(Date.now() / 1000) + min * 60;
}
function gwei(n) {
  return ethers.parseUnits(String(n), "gwei");
}
function fmtUnitsComma(bn, dec = 18, dp = 4) {
  try {
    if (bn == null) return "—";
    if (bn === 0n) return "0";
    const s = ethers.formatUnits(bn, dec);
    const [i, f = ""] = s.split(".");
    const withComma = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (!f) return withComma;

    const shown = f.slice(0, dp);
    const shownTrim = shown.replace(/0+$/, "");

    // tiny non-zero that would look like 0.0000
    if (i === "0" && shown.replace(/0/g, "").length === 0) {
      return `<0.${"0".repeat(Math.max(0, dp - 1))}1`;
    }

    return shownTrim ? `${withComma}.${shownTrim}` : withComma;
  } catch {
    return "—";
  }
}
function fmtNumComma(n, dp = 2) {
  if (n == null) return "—";
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  const fixed = x.toFixed(dp);

  // dp=0 => no decimal point
  if (!fixed.includes(".")) {
    return fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  const [i, f] = fixed.split(".");
  const withComma = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${withComma}.${f}`.replace(/\.00$/, "");
}
function fmtGwei(wei) {
  if (wei == null) return "—";
  try {
    const s = ethers.formatUnits(wei, "gwei");
    const n = Number(s);
    if (!Number.isFinite(n)) return s;
    return n.toFixed(2).replace(/\.00$/, "");
  } catch {
    return "—";
  }
}
function estConfirmLabel(prioGwei) {
  const p = Number(prioGwei);
  if (!Number.isFinite(p)) return "—";
  if (p >= 7) return "Aggro ⚡";
  if (p >= 4) return "Fast ✅";
  if (p >= 2) return "Normal 🙂";
  return "Slow 🐢";
}
function shortHash(h) {
  if (!h || typeof h !== "string") return "—";
  return h.slice(0, 6) + "…" + h.slice(-4);
}

/* ===================== FILES ===================== */
const DATA_DIR = __dirname;
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const PUMP_FILE = path.join(DATA_DIR, "pump_contracts.json");
const POS_FILE = path.join(DATA_DIR, "positions.json"); // PLS-only PnL

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonSafe(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

/* ===================== SETTINGS ===================== */
const DEFAULT_SETTINGS = {
  buyPls: "1000",
  slippagePct: 5,
  gasLimit: "350000",
  feePresets: {
    NORMAL: { maxFeeGwei: "25", prioFeeGwei: "2" },
    FAST: { maxFeeGwei: "40", prioFeeGwei: "4" },
    AGGRO: { maxFeeGwei: "65", prioFeeGwei: "7" },
  },
  activeFee: "FAST",

  // Editable quick-amount buttons (PLS)
  quickBuyAmounts: ["2000000", "5000000", "10000000", "15000000", "20000000"],
};

function loadSettingsAll() {
  return readJsonSafe(SETTINGS_FILE, {});
}
function saveSettingsAll(all) {
  writeJsonSafe(SETTINGS_FILE, all);
}
function getUserSettings(tgId) {
  const all = loadSettingsAll();
  if (!all[String(tgId)]) all[String(tgId)] = structuredClone(DEFAULT_SETTINGS);
  const s = all[String(tgId)];

  if (!s.buyPls) s.buyPls = DEFAULT_SETTINGS.buyPls;
  if (s.slippagePct == null) s.slippagePct = DEFAULT_SETTINGS.slippagePct;
  if (!s.gasLimit) s.gasLimit = DEFAULT_SETTINGS.gasLimit;
  if (!s.feePresets) s.feePresets = structuredClone(DEFAULT_SETTINGS.feePresets);
  if (!s.activeFee) s.activeFee = DEFAULT_SETTINGS.activeFee;
  if (!Array.isArray(s.quickBuyAmounts) || s.quickBuyAmounts.length === 0) {
    s.quickBuyAmounts = [...DEFAULT_SETTINGS.quickBuyAmounts];
  }

  all[String(tgId)] = s;
  saveSettingsAll(all);
  return s;
}
function setUserSettings(tgId, s) {
  const all = loadSettingsAll();
  all[String(tgId)] = s;
  saveSettingsAll(all);
}

function currentFeePreset(tgId) {
  const s = getUserSettings(tgId);
  const fp = s.feePresets?.[s.activeFee] || DEFAULT_SETTINGS.feePresets.FAST;
  return { s, fp };
}
function currentFeeFields(tgId) {
  const { s, fp } = currentFeePreset(tgId);
  return {
    label: s.activeFee,
    maxFeePerGas: gwei(fp.maxFeeGwei),
    maxPriorityFeePerGas: gwei(fp.prioFeeGwei),
    maxFeeGwei: fp.maxFeeGwei,
    prioFeeGwei: fp.prioFeeGwei,
  };
}

/* ===================== PUMP LIST ===================== */
function pumpList() {
  return readJsonSafe(PUMP_FILE, []);
}
function addPumpContract(addr) {
  if (!isAddr(addr)) return false;
  const a = normAddr(addr);
  const list = pumpList();
  if (!list.includes(a)) {
    list.push(a);
    writeJsonSafe(PUMP_FILE, list);
  }
  return true;
}

/* ===================== POSITIONS / PnL (PLS-only) ===================== */
function loadPositionsAll() {
  return readJsonSafe(POS_FILE, {});
}
function savePositionsAll(all) {
  writeJsonSafe(POS_FILE, all);
}
function getPos(token) {
  const all = loadPositionsAll();
  const k = token.toLowerCase();
  if (!all[k]) all[k] = { qty: "0", decimals: 18, symbol: "TOKEN", costPls: "0", realizedPls: "0" };
  return { all, k, pos: all[k] };
}
function numStrAdd(a, b) {
  const x = Number(a || "0");
  const y = Number(b || "0");
  return String(x + y);
}

/* ===================== BOT INIT ===================== */
const bot = new Telegraf(BOT_TOKEN);

// state
const state = new Map();          // tgId -> { token, symbol, decimals }
const statusMsgId = new Map();    // tgId -> message_id
const chatIdByUser = new Map();   // tgId -> chat.id
const awaiting = new Map();       // tgId -> "token" | "amount" | "gas" | "fees" | "qamounts" | null
const lastTx = new Map();         // tgId -> last tx data

// Pending tx per user (for UX + auto refresh + PnL updates on mine)
const pendingTx = new Map();
/**
 * tgId -> {
 *   hash, nonce, kind, startedAt,
 *   action: "BUY_PULSEX"|"SELL_PULSEX"|"BUY_PUMP"|"APPROVE"|"SPEEDUP"|"CANCEL",
 *   token,
 *   buyPls, percent,
 *   prePlsWei, preTokWei,
 *   maxFeePerGas, maxPriorityFeePerGas
 * }
 */

// middleware: log + protect
function requireOwner(ctx) {
  if (ctx.from?.id !== OWNER_ID) {
    try { ctx.reply(`❌ Unauthorized. Your id: ${ctx.from?.id}`); } catch {}
    return false;
  }
  return true;
}

bot.use(async (ctx, next) => {
  try {
    const msg = ctx.message?.text || ctx.callbackQuery?.data || "";
    console.log("IN:", ctx.from?.id, msg);
    return await next();
  } catch (e) {
    console.error("MIDDLEWARE ERROR:", e);
    try { await ctx.reply(`❌ Error: ${e?.message || e}`); } catch {}
  }
});

bot.catch((err) => {
  console.error("BOT.CATCH:", err);
});

/* ===================== TOKEN INFO ===================== */
async function fetchTokenInfo(provider, token) {
  const c = new ethers.Contract(token, ERC20_ABI, provider);
  const [sym, dec] = await Promise.all([
    withTimeout(c.symbol(), 1500, "TOKEN"),
    withTimeout(c.decimals(), 1500, 18),
  ]);
  return { symbol: sym || "TOKEN", decimals: Number(dec) || 18 };
}

/* ===================== ROUTE CHECK ===================== */
async function hasPulseXLiquidity(provider, token) {
  try {
    const router = new ethers.Contract(PULSEX_ROUTER, ROUTER_ABI, provider);
    const testIn = ethers.parseEther("0.01");
    const out = await withTimeout(router.getAmountsOut(testIn, [WPLS, token]), 1500, null);
    return !!(out && out[1] && out[1] > 0n);
  } catch {
    return false;
  }
}

/* ===================== TX RECEIPT (robust) ===================== */
async function getReceiptAny(hash) {
  const [a, b] = await Promise.allSettled([
    withTimeout(providerBackup.getTransactionReceipt(hash), 1500, null), // always try publicnode
    withTimeout(providerPrimary.getTransactionReceipt(hash), 1500, null),
  ]);
  const ra = a.status === "fulfilled" ? a.value : null;
  if (ra) return ra;
  const rb = b.status === "fulfilled" ? b.value : null;
  return rb || null;
}

/* ===================== PUMP BUY (raw calldata) ===================== */
const PUMP_BUY_SELECTOR = "0x58bbe38e";

function encodePumpBuyCalldata(token, outParam) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const args = coder.encode(["address", "uint256"], [token, outParam]);
  return PUMP_BUY_SELECTOR + args.slice(2);
}

async function probePumpOut(provider, pumpAddr, token, valueWei, fromAddr) {
  const baseReq = { to: pumpAddr, value: valueWei, from: fromAddr };

  async function ok(x) {
    try {
      await provider.call({ ...baseReq, data: encodePumpBuyCalldata(token, x) });
      return true;
    } catch {
      return false;
    }
  }

  if (!(await ok(0n))) return null;

  let lo = 0n;
  let hi = 1n;

  for (let i = 0; i < 64; i++) {
    if (await ok(hi)) {
      lo = hi;
      hi = hi * 2n;
    } else break;
  }

  if (await ok(hi)) return hi;

  for (let i = 0; i < 128; i++) {
    if (hi - lo <= 1n) break;
    const mid = lo + (hi - lo) / 2n;
    if (await ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

async function buyPumpTires(tgId, token) {
  const s = getUserSettings(tgId);
  await refreshFastestRpc();

  const provider = readProvider();
  const signer = sendWallet();

  const pumps = pumpList();
  if (!pumps.length) {
    throw new Error("No pump contracts known yet. Use /learn <successful pump buy txhash> once.");
  }

  const valueWei = ethers.parseEther(String(s.buyPls));
  const fees = currentFeeFields(tgId);
  const gasLimit = BigInt(s.gasLimit);

  // snapshots (best-effort)
  const prePls = await withTimeout(provider.getBalance(signer.address), 2500, null);
  const preTok = await withTimeout(new ethers.Contract(token, ERC20_ABI, provider).balanceOf(signer.address), 2500, 0n);

  let lastErr = null;

  for (const pumpAddr of pumps) {
    try {
      const maxOut = await probePumpOut(provider, pumpAddr, token, valueWei, signer.address);
      if (maxOut == null) continue;

      const slipBps = BigInt(Math.floor(Number(s.slippagePct) * 100)); // 5% => 500
      const outParam = (maxOut * (10000n - slipBps)) / 10000n;
      const data = encodePumpBuyCalldata(token, outParam);

      const est = await withTimeout(
        provider.estimateGas({ to: pumpAddr, from: signer.address, value: valueWei, data }),
        2000,
        null
      );
      if (est == null) continue;

      const tx = await signer.sendTransaction({
        to: pumpAddr,
        value: valueWei,
        data,
        gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });

      lastTx.set(tgId, {
        hash: tx.hash,
        nonce: tx.nonce,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
        gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });

      pendingTx.set(tgId, {
        hash: tx.hash,
        nonce: tx.nonce,
        kind: "BUY (PUMP)",
        startedAt: Date.now(),
        action: "BUY_PUMP",
        token,
        buyPls: s.buyPls,
        prePlsWei: prePls,
        preTokWei: preTok,
        maxFeePerGas: tx.maxFeePerGas ?? null,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
      });

      addPumpContract(pumpAddr);

      return { hash: tx.hash, pumpAddr };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  throw new Error(`PUMP_UNSUPPORTED: No pump contract matched. Last error: ${lastErr?.message || lastErr}`);
}

/* ===================== PulseX BUY/SELL (instant return) ===================== */
async function buyPulseX(tgId, token) {
  const s = getUserSettings(tgId);
  await refreshFastestRpc();

  const provider = readProvider();
  const signer = sendWallet();
  const router = new ethers.Contract(PULSEX_ROUTER, ROUTER_ABI, signer);

  const value = ethers.parseEther(String(s.buyPls));
  const path = [WPLS, token];

  // snapshots
  const prePls = await withTimeout(provider.getBalance(signer.address), 2500, null);
  const tokenCRead = new ethers.Contract(token, ERC20_ABI, provider);
  const preTok = await withTimeout(tokenCRead.balanceOf(signer.address), 2500, 0n);

  const amounts = await router.getAmountsOut(value, path);
  const expectedOut = amounts[1];

  const slipBps = BigInt(Math.floor(Number(s.slippagePct) * 100));
  const minOut = (expectedOut * (10000n - slipBps)) / 10000n;

  const fees = currentFeeFields(tgId);
  const gasLimit = BigInt(s.gasLimit);

  const txReq = await router.swapExactETHForTokens.populateTransaction(
    minOut,
    path,
    signer.address,
    nowPlus(5),
    { value }
  );

  const tx = await signer.sendTransaction({
    ...txReq,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });

  lastTx.set(tgId, {
    hash: tx.hash,
    nonce: tx.nonce,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });

  pendingTx.set(tgId, {
    hash: tx.hash,
    nonce: tx.nonce,
    kind: "BUY",
    startedAt: Date.now(),
    action: "BUY_PULSEX",
    token,
    buyPls: s.buyPls,
    prePlsWei: prePls,
    preTokWei: preTok,
    maxFeePerGas: tx.maxFeePerGas ?? null,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
  });

  return tx.hash;
}

async function sellPulseX(tgId, token, percent) {
  const s = getUserSettings(tgId);
  await refreshFastestRpc();

  const provider = readProvider();
  const signer = sendWallet();

  const router = new ethers.Contract(PULSEX_ROUTER, ROUTER_ABI, signer);
  const tokenC = new ethers.Contract(token, ERC20_ABI, signer);

  const bal = await tokenC.balanceOf(signer.address);
  const amountIn = (bal * BigInt(percent)) / 100n;
  if (amountIn === 0n) throw new Error("No token balance to sell.");

  // snapshots
  const prePls = await withTimeout(provider.getBalance(signer.address), 2500, null);
  const preTok = await withTimeout(new ethers.Contract(token, ERC20_ABI, provider).balanceOf(signer.address), 2500, bal);

  const allowance = await tokenC.allowance(signer.address, PULSEX_ROUTER);

  // Instant-return APPROVE if needed
  if (allowance < amountIn) {
    const aTx = await tokenC.approve(PULSEX_ROUTER, ethers.MaxUint256);

    lastTx.set(tgId, {
      hash: aTx.hash,
      nonce: aTx.nonce,
      to: aTx.to,
      data: aTx.data,
      value: aTx.value ?? 0n,
      gasLimit: aTx.gasLimit ?? 120000n,
      maxFeePerGas: aTx.maxFeePerGas ?? gwei(40),
      maxPriorityFeePerGas: aTx.maxPriorityFeePerGas ?? gwei(4),
    });

    pendingTx.set(tgId, {
      hash: aTx.hash,
      nonce: aTx.nonce,
      kind: "APPROVE",
      startedAt: Date.now(),
      action: "APPROVE",
      token,
      prePlsWei: prePls,
      preTokWei: preTok,
      maxFeePerGas: aTx.maxFeePerGas ?? null,
      maxPriorityFeePerGas: aTx.maxPriorityFeePerGas ?? null,
    });

    return aTx.hash;
  }

  const path = [token, WPLS];
  const amounts = await router.getAmountsOut(amountIn, path);
  const expectedOut = amounts[1];

  const slipBps = BigInt(Math.floor(Number(s.slippagePct) * 100));
  const minOut = (expectedOut * (10000n - slipBps)) / 10000n;

  const fees = currentFeeFields(tgId);
  const gasLimit = BigInt(s.gasLimit);

  const txReq = await router.swapExactTokensForETH.populateTransaction(
    amountIn,
    minOut,
    path,
    signer.address,
    nowPlus(5)
  );

  const tx = await signer.sendTransaction({
    ...txReq,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });

  lastTx.set(tgId, {
    hash: tx.hash,
    nonce: tx.nonce,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });

  pendingTx.set(tgId, {
    hash: tx.hash,
    nonce: tx.nonce,
    kind: `SELL ${percent}%`,
    startedAt: Date.now(),
    action: "SELL_PULSEX",
    token,
    percent,
    prePlsWei: prePls,
    preTokWei: preTok,
    maxFeePerGas: tx.maxFeePerGas ?? null,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
  });

  return tx.hash;
}

/* ===================== SPEEDUP / CANCEL (lastTx) ===================== */
function maxBig(a, b) { return a > b ? a : b; }

async function buildBumpedFees(provider, prevMax, prevPrio) {
  const block = await withTimeout(provider.getBlock("latest"), 1500, null);
  const base = block?.baseFeePerGas ?? 0n;

  const fd = await withTimeout(provider.getFeeData(), 1500, null);
  const sugPrio = fd?.maxPriorityFeePerGas ?? gwei(2);
  const sugMax = fd?.maxFeePerGas ?? (base + sugPrio);

  // If RPC returns absurd numbers, ignore and just bump from previous
  const sugMaxGwei = Number(ethers.formatUnits(sugMax, "gwei"));
  const sugPrioGwei = Number(ethers.formatUnits(sugPrio, "gwei"));
  const sane = Number.isFinite(sugMaxGwei) && sugMaxGwei < 5000 && Number.isFinite(sugPrioGwei) && sugPrioGwei < 5000;

  // bump 25%
  const bumpedPrio = (prevPrio * 125n) / 100n;
  const bumpedMax = (prevMax * 125n) / 100n;

  let prio = bumpedPrio;
  let maxFee = bumpedMax;

  if (sane) {
    prio = maxBig(bumpedPrio, (sugPrio * 110n) / 100n);
    const need = base + prio;
    maxFee = maxBig(maxBig(bumpedMax, (sugMax * 105n) / 100n), need);
  } else {
    // ensure maxFee >= base + prio
    const need = base + prio;
    if (maxFee < need) maxFee = need + gwei(10);
  }

  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, baseFeePerGas: base, sugPrio, sugMax };
}

function upsertPendingReplacement(tgId, { hash, nonce, kind, maxFeePerGas, maxPriorityFeePerGas }) {
  const p = pendingTx.get(tgId);

  if (p && p.nonce === nonce) {
    pendingTx.set(tgId, {
      ...p,
      hash,
      kind: kind || p.kind,
      startedAt: Date.now(),
      maxFeePerGas: maxFeePerGas ?? p.maxFeePerGas ?? null,
      maxPriorityFeePerGas: maxPriorityFeePerGas ?? p.maxPriorityFeePerGas ?? null,
    });
    return true;
  }

  pendingTx.set(tgId, {
    hash,
    nonce,
    kind: kind || "REPLACEMENT",
    startedAt: Date.now(),
    action: "SPEEDUP",
    token: p?.token || (state.get(tgId)?.token ?? null),
    prePlsWei: p?.prePlsWei ?? null,
    preTokWei: p?.preTokWei ?? null,
    buyPls: p?.buyPls,
    percent: p?.percent,
    maxFeePerGas: maxFeePerGas ?? null,
    maxPriorityFeePerGas: maxPriorityFeePerGas ?? null,
  });
  return false;
}

async function speedUpLastTx(tgId) {
  const prev = lastTx.get(tgId);
  if (!prev) throw new Error("No previous transaction to speed up.");

  await refreshFastestRpc();
  const provider = readProvider();
  const signer = sendWallet();
  const bumped = await buildBumpedFees(provider, prev.maxFeePerGas, prev.maxPriorityFeePerGas);

  const tx = await signer.sendTransaction({
    to: prev.to,
    data: prev.data,
    value: prev.value,
    nonce: prev.nonce,
    gasLimit: prev.gasLimit,
    maxFeePerGas: bumped.maxFeePerGas,
    maxPriorityFeePerGas: bumped.maxPriorityFeePerGas,
  });

  lastTx.set(tgId, {
    ...prev,
    hash: tx.hash,
    maxFeePerGas: bumped.maxFeePerGas,
    maxPriorityFeePerGas: bumped.maxPriorityFeePerGas,
  });

  upsertPendingReplacement(tgId, {
    hash: tx.hash,
    nonce: prev.nonce,
    kind: "SPEEDUP",
    maxFeePerGas: bumped.maxFeePerGas,
    maxPriorityFeePerGas: bumped.maxPriorityFeePerGas,
  });

  return tx.hash;
}

async function cancelLastTx(tgId) {
  const prev = lastTx.get(tgId);
  if (!prev) throw new Error("No previous transaction to cancel.");

  await refreshFastestRpc();
  const provider = readProvider();
  const signer = sendWallet();
  const bumped = await buildBumpedFees(provider, prev.maxFeePerGas, prev.maxPriorityFeePerGas);

  const tx = await signer.sendTransaction({
    to: signer.address,
    value: 0n,
    data: "0x",
    nonce: prev.nonce,
    gasLimit: 21000n,
    maxFeePerGas: bumped.maxFeePerGas,
    maxPriorityFeePerGas: bumped.maxPriorityFeePerGas,
  });

  lastTx.set(tgId, {
    ...prev,
    hash: tx.hash,
    to: signer.address,
    data: "0x",
    value: 0n,
    gasLimit: 21000n,
    maxFeePerGas: bumped.maxFeePerGas,
    maxPriorityFeePerGas: bumped.maxPriorityFeePerGas,
  });

  upsertPendingReplacement(tgId, {
    hash: tx.hash,
    nonce: prev.nonce,
    kind: "CANCEL",
    maxFeePerGas: bumped.maxFeePerGas,
    maxPriorityFeePerGas: bumped.maxPriorityFeePerGas,
  });

  return tx.hash;
}

/* ===================== NONCE TOOLS (unclog) ===================== */
async function cancelNonce(tgId, nonce) {
  await refreshFastestRpc();
  const provider = readProvider();
  const signer = sendWallet();

  // fee data (guard against insane RPC values)
  const fd = await withTimeout(provider.getFeeData(), 1500, null);
  const block = await withTimeout(provider.getBlock("latest"), 1500, null);
  const base = block?.baseFeePerGas ?? 0n;

  let prio = fd?.maxPriorityFeePerGas ?? gwei(3);
  let maxFee = fd?.maxFeePerGas ?? (base + prio);

  const maxFeeG = Number(ethers.formatUnits(maxFee, "gwei"));
  if (!Number.isFinite(maxFeeG) || maxFeeG > 5000) {
    prio = gwei(10);
    maxFee = base + prio + gwei(100);
  }

  const tx = await signer.sendTransaction({
    to: signer.address,
    value: 0n,
    data: "0x",
    nonce: Number(nonce),
    gasLimit: 21000n,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: prio,
  });

  lastTx.set(tgId, {
    hash: tx.hash,
    nonce: tx.nonce,
    to: signer.address,
    data: "0x",
    value: 0n,
    gasLimit: 21000n,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: prio,
  });

  pendingTx.set(tgId, {
    hash: tx.hash,
    nonce: tx.nonce,
    kind: `CANCEL NONCE ${tx.nonce}`,
    startedAt: Date.now(),
    action: "CANCEL",
    token: state.get(tgId)?.token ?? null,
    prePlsWei: null,
    preTokWei: null,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: prio,
  });

  return tx.hash;
}

/* ===================== POST-MINED POSITION UPDATES ===================== */
async function applyMinedUpdate(tgId, pend) {
  const provider = readProvider();
  const w = sendWallet();
  const token = pend.token;
  if (!token || !isAddr(token)) return;

  const tokenC = new ethers.Contract(token, ERC20_ABI, provider);

  const postPlsWei = await withTimeout(provider.getBalance(w.address), 2500, null);
  const postTokWei = await withTimeout(tokenC.balanceOf(w.address), 2500, null);

  const prePlsWei = pend.prePlsWei ?? null;
  const preTokWei = pend.preTokWei ?? null;

  if (postPlsWei == null || postTokWei == null || prePlsWei == null || preTokWei == null) return;

  const plsSpentWei = prePlsWei > postPlsWei ? (prePlsWei - postPlsWei) : 0n;
  const plsReceivedWei = postPlsWei > prePlsWei ? (postPlsWei - prePlsWei) : 0n;

  const tokGained = postTokWei > preTokWei ? (postTokWei - preTokWei) : 0n;
  const tokSold = preTokWei > postTokWei ? (preTokWei - postTokWei) : 0n;

  const { all, k, pos } = getPos(token);

  // keep metadata nice
  const st = state.get(tgId) || {};
  pos.symbol = st.symbol || pos.symbol;
  pos.decimals = st.decimals || pos.decimals;

  if (pend.action === "BUY_PULSEX") {
    const spentPls = Number(ethers.formatEther(plsSpentWei));
    pos.qty = String(BigInt(pos.qty || "0") + tokGained);
    pos.costPls = numStrAdd(pos.costPls, String(spentPls));
  }

  if (pend.action === "SELL_PULSEX") {
    const receivedPls = Number(ethers.formatEther(plsReceivedWei));

    const soldTok = tokSold;
    const posQtyNow = BigInt(pos.qty || "0");
    const posCostNow = Number(pos.costPls || "0");

    if (soldTok > 0n && posQtyNow > 0n && posCostNow > 0) {
      const frac = Number(soldTok) / Number(posQtyNow); // UI-level accounting
      const costPortion = Math.min(posCostNow, posCostNow * frac);
      const realized = receivedPls - costPortion;

      pos.qty = String(posQtyNow - soldTok);
      pos.costPls = String(Math.max(0, posCostNow - costPortion));
      pos.realizedPls = numStrAdd(pos.realizedPls, String(realized));
    }
  }

  if (pend.action === "BUY_PUMP") {
    const buyPls = Number(pend.buyPls || "0");
    if (Number.isFinite(buyPls) && buyPls > 0) {
      pos.costPls = numStrAdd(pos.costPls, String(buyPls));
    }
  }

  all[k] = pos;
  savePositionsAll(all);
}

/* ===================== WATCHER (auto refresh on mined) ===================== */
async function upsertStatusByUserId(tgId) {
  const chatId = chatIdByUser.get(tgId);
  const mid = statusMsgId.get(tgId);
  if (!chatId || !mid) return;

  const ctxLike = {
    chat: { id: chatId },
    telegram: bot.telegram,
    reply: async (...args) => bot.telegram.sendMessage(chatId, ...args),
  };

  await upsertStatus(ctxLike, tgId);
}

function startPendingWatcher() {
  setInterval(async () => {
    for (const [tgId, p] of pendingTx.entries()) {
      try {
        const rec = await getReceiptAny(p.hash);
        if (rec) {
          pendingTx.delete(tgId);

          const chatId = chatIdByUser.get(tgId);
          const ok = rec.status === 1 ? "✅ Confirmed" : "❌ Failed";

          if (rec.status === 1) {
            try { await applyMinedUpdate(tgId, p); } catch {}
          }

          if (chatId) {
            await bot.telegram.sendMessage(chatId, `${ok} (${p.kind})\n${p.hash}`);
          }

          await upsertStatusByUserId(tgId);
        }
      } catch {
        // ignore intermittent issues
      }
    }
  }, 2500);
}

/* ===================== UI ===================== */
function mainKeyboard(tgId) {
  const s = getUserSettings(tgId);
  const qa = s.quickBuyAmounts;

  // mark active preset with ✅
  const n = s.activeFee === "NORMAL" ? "🟦 Normal ✅" : "🟦 Normal";
  const f = s.activeFee === "FAST" ? "⚡ Fast ✅" : "⚡ Fast";
  const a = s.activeFee === "AGGRO" ? "🔥 Aggro ✅" : "🔥 Aggro";

  const qlab = (idx) => {
    const v = qa?.[idx];
    if (!v) return "—";
    return fmtNumComma(Number(String(v).replace(/,/g, "")), 0);
  };

  return Markup.inlineKeyboard([
    // Fee presets row
    [
      Markup.button.callback(n, "FEE_NORMAL"),
      Markup.button.callback(f, "FEE_FAST"),
      Markup.button.callback(a, "FEE_AGGRO"),
    ],

    // Quick amounts (editable)
    [
      Markup.button.callback(qlab(0), "QBUY_0"),
      Markup.button.callback(qlab(1), "QBUY_1"),
      Markup.button.callback(qlab(2), "QBUY_2"),
    ],
    [
      Markup.button.callback(qlab(3), "QBUY_3"),
      Markup.button.callback(qlab(4), "QBUY_4"),
    ],

    // Main controls
    [Markup.button.callback("📌 Token", "SET_TOKEN"), Markup.button.callback("🔄 Refresh", "REFRESH")],
    [Markup.button.callback("🟢 Buy", "BUY"), Markup.button.callback("⚡ SpeedUp", "SPEEDUP")],
    [Markup.button.callback("Sell 25%", "SELL_25"), Markup.button.callback("Sell 50%", "SELL_50")],
    [Markup.button.callback("Sell 100%", "SELL_100"), Markup.button.callback("🛑 Cancel", "CANCEL")],

    // Editors
    [Markup.button.callback("💰 Amount", "AMOUNT"), Markup.button.callback("✏️ Edit Fees", "EDIT_FEES")],
    [Markup.button.callback("✏️ Edit Quick Amounts", "EDIT_QAMTS"), Markup.button.callback("⛽ Gas Limit", "EDIT_GAS")],
  ]);
}

function pendFeeLine(p) {
  if (!p) return "";
  const mf = p.maxFeePerGas ? fmtGwei(p.maxFeePerGas) : "—";
  const pr = p.maxPriorityFeePerGas ? fmtGwei(p.maxPriorityFeePerGas) : "—";
  const nn = (p.nonce ?? "—");
  return `🔁 Nonce: *${nn}* | max *${mf}* / prio *${pr}* (gwei)\n`;
}

async function buildStatus(tgId) {
  const s = getUserSettings(tgId);
  await refreshFastestRpc();

  const provider = readProvider();
  const w = sendWallet();
  const st = state.get(tgId) || {};
  const token = st.token;
  const pend = pendingTx.get(tgId) || null;

  // balances
  const plsWei = await withTimeout(provider.getBalance(w.address), 2500, null);
  const pls = plsWei == null ? "—" : fmtUnitsComma(plsWei, 18, 4);

  let tokenBalDisp = "—";
  let route = "—";
  let sym = st.symbol || "TOKEN";
  let dec = st.decimals || 18;

  if (token && isAddr(token)) {
    const pulsexOk = await hasPulseXLiquidity(provider, token);
    route = pulsexOk ? "PulseX ✅" : "Pump (pre-migration) ✅";

    try {
      const c = new ethers.Contract(token, ERC20_ABI, provider);
      const tb = await withTimeout(c.balanceOf(w.address), 2000, null);
      if (tb != null) tokenBalDisp = fmtUnitsComma(tb, dec, 4);
    } catch {
      tokenBalDisp = "—";
    }
  }

  // fee info
  const fees = currentFeeFields(tgId);
  const block = await withTimeout(provider.getBlock("latest"), 1500, null);
  const baseFee = block?.baseFeePerGas ?? null;

  const fd = await withTimeout(provider.getFeeData(), 1500, null);
  const sugPrio = fd?.maxPriorityFeePerGas ?? null;
  const sugMax = fd?.maxFeePerGas ?? null;

  // PnL (PLS-only)
  let pnlText = "—";
  if (token && isAddr(token)) {
    const { pos } = getPos(token);
    const cost = Number(pos.costPls || "0");
    const realized = Number(pos.realizedPls || "0");

    let unreal = 0;
    try {
      const qty = BigInt(pos.qty || "0");
      if (qty > 0n) {
        const router = new ethers.Contract(PULSEX_ROUTER, ROUTER_ABI, provider);
        const out = await withTimeout(router.getAmountsOut(qty, [token, WPLS]), 1500, null);
        if (out && out[1]) {
          const mkt = Number(ethers.formatEther(out[1]));
          unreal = mkt - cost;
        }
      }
    } catch {
      unreal = 0;
    }

    pnlText =
      `Cost: *${fmtNumComma(cost, 4)} PLS*\n` +
      `Unreal: *${fmtNumComma(unreal, 4)} PLS*\n` +
      `Realized: *${fmtNumComma(realized, 4)} PLS*`;
  }

  const pendingBlock = pend
    ? `🟡 Pending: *${pend.kind}* (${shortHash(pend.hash)})\n` +
      `⏱️ Age: *${Math.floor((Date.now() - pend.startedAt) / 1000)}s*\n` +
      `${pendFeeLine(pend)}`
    : "";

  const text =
`*PulseChain Trading Bot*
👛 Wallet: \`${w.address}\`
🌐 RPC: *${rpcState.active}* (P ${rpcState.msPrimary ?? "—"}ms | B ${rpcState.msBackup ?? "—"}ms)
${pendingBlock}🧭 Route: *${route}*

💠 PLS: *${pls}*
🪙 Token: *${token ? sym : "—"}*
📦 Token Bal: *${tokenBalDisp}*

⛽ Fee preset: *${fees.label}*  (max ${fees.maxFeeGwei} / prio ${fees.prioFeeGwei})
🕒 Est confirm: *${estConfirmLabel(fees.prioFeeGwei)}*
🧱 Base fee: *${fmtGwei(baseFee)} gwei*
💡 Suggested: max *${fmtGwei(sugMax)}* / prio *${fmtGwei(sugPrio)}* (gwei)

📈 *PnL (PLS-only)*
${pnlText}
`;

  return { text };
}

async function upsertStatus(ctx, tgId) {
  const { text } = await buildStatus(tgId);
  const mid = statusMsgId.get(tgId);

  if (!mid) {
    const m = await ctx.reply(text, { parse_mode: "Markdown", ...mainKeyboard(tgId) });
    statusMsgId.set(tgId, m.message_id);
    return;
  }

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, mid, undefined, text, {
      parse_mode: "Markdown",
      ...mainKeyboard(tgId),
    });
  } catch {
    const m = await ctx.reply(text, { parse_mode: "Markdown", ...mainKeyboard(tgId) });
    statusMsgId.set(tgId, m.message_id);
  }
}

/* ===================== COMMANDS ===================== */
bot.command("ping", (ctx) => {
  if (!requireOwner(ctx)) return;
  return ctx.reply("pong ✅");
});

bot.command("myid", (ctx) => {
  return ctx.reply(`Your ID: ${ctx.from.id}`);
});

bot.command("nonce", async (ctx) => {
  if (!requireOwner(ctx)) return;
  try {
    await refreshFastestRpc();
    const p = providerBackup; // nonce truth from broadcast RPC
    const w = sendWallet();
    const latest = await p.getTransactionCount(w.address, "latest");
    const pending = await p.getTransactionCount(w.address, "pending");
    return ctx.reply(`Nonce info:\nlatest: ${latest}\npending: ${pending}\ngap: ${pending - latest}`);
  } catch (e) {
    return ctx.reply(`❌ nonce check failed: ${e?.message || e}`);
  }
});

bot.command("cancelnonce", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const n = Number(parts[1]);
  if (!Number.isFinite(n)) return ctx.reply("Usage: /cancelnonce 418");

  try {
    const h = await cancelNonce(ctx.from.id, n);
    await ctx.reply(`🛑 Cancel nonce ${n} submitted:\n${h}`);
    await upsertStatus(ctx, ctx.from.id);
  } catch (e) {
    return ctx.reply(`❌ cancelnonce failed: ${e?.message || e}`);
  }
});

bot.command("pump", (ctx) => {
  if (!requireOwner(ctx)) return;
  const list = pumpList();
  if (!list.length) return ctx.reply("No pump contracts known.\nUse: /learn <successful pump buy txhash>\n(or /addpump <addr>)");
  return ctx.reply(`Known pump contracts (${list.length}):\n` + list.join("\n"));
});

bot.command("addpump", (ctx) => {
  if (!requireOwner(ctx)) return;
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const addr = parts[1];
  if (!addr) return ctx.reply("Usage: /addpump 0xYourPumpContract");
  if (!addPumpContract(addr)) return ctx.reply("❌ Invalid address.");
  return ctx.reply("✅ Added pump contract.");
});

bot.command("learn", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const hash = parts[1];
  if (!hash || !hash.startsWith("0x") || hash.length !== 66) {
    return ctx.reply("Usage: /learn 0xTXHASH (a successful pump.tires buy tx)");
  }
  try {
    await refreshFastestRpc();
    const p = readProvider();
    const tx = await p.getTransaction(hash);
    if (!tx?.to) return ctx.reply("❌ Could not fetch tx.to");
    if (!addPumpContract(tx.to)) return ctx.reply("❌ tx.to not a valid address");
    return ctx.reply(`✅ Learned pump contract:\n${normAddr(tx.to)}\nRun /pump to confirm.`);
  } catch (e) {
    return ctx.reply(`❌ Learn failed: ${e?.message || e}`);
  }
});

/* ===================== START ===================== */
bot.start(async (ctx) => {
  if (!requireOwner(ctx)) return;
  const tgId = ctx.from.id;

  chatIdByUser.set(tgId, ctx.chat.id);

  await refreshFastestRpc();
  state.set(tgId, { token: null, symbol: null, decimals: null });
  awaiting.delete(tgId);

  await upsertStatus(ctx, tgId);
});

bot.hears(/^\/start(@\w+)?$/i, async (ctx) => {
  if (!requireOwner(ctx)) return;
  const tgId = ctx.from.id;

  chatIdByUser.set(tgId, ctx.chat.id);

  await refreshFastestRpc();
  state.set(tgId, { token: null, symbol: null, decimals: null });
  awaiting.delete(tgId);

  await upsertStatus(ctx, tgId);
});

/* ===================== ACTIONS ===================== */
bot.action("REFRESH", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;
  await upsertStatus(ctx, ctx.from.id);
});

bot.action("SET_TOKEN", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;
  awaiting.set(ctx.from.id, "token");
  await ctx.reply("Paste TOKEN contract address (0x...)");
});

bot.action("AMOUNT", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;
  awaiting.set(ctx.from.id, "amount");
  const s = getUserSettings(ctx.from.id);
  await ctx.reply(`Send BUY amount in PLS.\nCurrent: ${fmtNumComma(Number(s.buyPls), 4)}\nExample: 1000 or 2,500,000.5`);
});

bot.action("EDIT_GAS", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;
  awaiting.set(ctx.from.id, "gas");
  const s = getUserSettings(ctx.from.id);
  await ctx.reply(`Send gas limit as a number.\nCurrent: ${s.gasLimit}\nExample: 350000`);
});

bot.action("EDIT_FEES", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;
  awaiting.set(ctx.from.id, "fees");
  const s = getUserSettings(ctx.from.id);
  const fp = s.feePresets;
  await ctx.reply(
    "Send fee presets in this format (max prio) one per line:\n\n" +
      `NORMAL ${fp.NORMAL.maxFeeGwei} ${fp.NORMAL.prioFeeGwei}\n` +
      `FAST ${fp.FAST.maxFeeGwei} ${fp.FAST.prioFeeGwei}\n` +
      `AGGRO ${fp.AGGRO.maxFeeGwei} ${fp.AGGRO.prioFeeGwei}\n\n` +
      "Optional: add ACTIVE <NORMAL|FAST|AGGRO>\n" +
      "Example:\nNORMAL 25 2\nFAST 40 4\nAGGRO 65 7\nACTIVE FAST"
  );
});

bot.action("EDIT_QAMTS", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;

  awaiting.set(ctx.from.id, "qamounts");
  await ctx.reply(
    "Send quick buy amounts (one per line).\nExample:\n" +
    "2000000\n5000000\n10000000\n15000000\n20000000"
  );
});

// Fee preset quick toggles
bot.action("FEE_NORMAL", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;
  const s = getUserSettings(ctx.from.id);
  s.activeFee = "NORMAL";
  setUserSettings(ctx.from.id, s);
  await upsertStatus(ctx, ctx.from.id);
});
bot.action("FEE_FAST", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;
  const s = getUserSettings(ctx.from.id);
  s.activeFee = "FAST";
  setUserSettings(ctx.from.id, s);
  await upsertStatus(ctx, ctx.from.id);
});
bot.action("FEE_AGGRO", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;
  const s = getUserSettings(ctx.from.id);
  s.activeFee = "AGGRO";
  setUserSettings(ctx.from.id, s);
  await upsertStatus(ctx, ctx.from.id);
});

// Quick buy amount taps (updates buyPls instantly)
bot.action(/^QBUY_(\d)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;

  const tgId = ctx.from.id;
  const idx = Number(ctx.match[1]);
  const s = getUserSettings(tgId);
  const val = s.quickBuyAmounts?.[idx];
  if (!val) return;

  s.buyPls = String(val);
  setUserSettings(tgId, s);
  await upsertStatus(ctx, tgId);
});

bot.action("BUY", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;

  const tgId = ctx.from.id;
  const st = state.get(tgId) || {};
  const token = st.token;
  if (!token) return ctx.reply("Set token first.");

  try {
    await refreshFastestRpc();
    const provider = readProvider();

    const pulsexOk = await hasPulseXLiquidity(provider, token);

    if (pulsexOk) {
      const txh = await buyPulseX(tgId, token);
      await ctx.reply(`🟢 Buy submitted\n${txh}`);
    } else {
      const r = await buyPumpTires(tgId, token);
      await ctx.reply(`🟢 Pump.tires buy submitted\nPump: ${r.pumpAddr}\n${r.hash}`);
    }

    await upsertStatus(ctx, tgId);
  } catch (e) {
    await ctx.reply(`❌ Buy failed: ${e?.message || e}`);
  }
});

async function doSell(ctx, pct) {
  const tgId = ctx.from.id;
  const st = state.get(tgId) || {};
  const token = st.token;
  if (!token) return ctx.reply("Set token first.");

  try {
    const txh = await sellPulseX(tgId, token, pct);

    const pend = pendingTx.get(tgId);
    if (pend?.action === "APPROVE") {
      await ctx.reply(`🟡 Approve submitted (needed before selling)\n${txh}\nWhen confirmed, press SELL again.`);
    } else {
      await ctx.reply(`🔴 Sell ${pct}% submitted\n${txh}`);
    }

    await upsertStatus(ctx, tgId);
  } catch (e) {
    await ctx.reply(`❌ Sell failed: ${e?.message || e}`);
  }
}

bot.action("SELL_25", async (ctx) => { await ctx.answerCbQuery(); if (!requireOwner(ctx)) return; return doSell(ctx, 25); });
bot.action("SELL_50", async (ctx) => { await ctx.answerCbQuery(); if (!requireOwner(ctx)) return; return doSell(ctx, 50); });
bot.action("SELL_100", async (ctx) => { await ctx.answerCbQuery(); if (!requireOwner(ctx)) return; return doSell(ctx, 100); });

bot.action("SPEEDUP", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;
  try {
    const txh = await speedUpLastTx(ctx.from.id);
    await ctx.reply(`⚡ Speed-up submitted\n${txh}`);
    await upsertStatus(ctx, ctx.from.id);
  } catch (e) {
    await ctx.reply(`❌ Speed-up failed: ${e?.message || e}`);
  }
});

bot.action("CANCEL", async (ctx) => {
  await ctx.answerCbQuery();
  if (!requireOwner(ctx)) return;
  try {
    const txh = await cancelLastTx(ctx.from.id);
    await ctx.reply(`🛑 Cancel submitted\n${txh}`);
    await upsertStatus(ctx, ctx.from.id);
  } catch (e) {
    await ctx.reply(`❌ Cancel failed: ${e?.message || e}`);
  }
});

/* ===================== TEXT INPUT ===================== */
bot.on("text", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const tgId = ctx.from.id;
  const text = (ctx.message.text || "").trim();
  const mode = awaiting.get(tgId);

  // token paste (also allow pasting anytime if it looks like address)
  if (mode === "token" || isAddr(text)) {
    const token = text;
    if (!isAddr(token)) return ctx.reply("❌ Not a valid address.");
    awaiting.delete(tgId);

    await refreshFastestRpc();
    const provider = readProvider();

    let info = { symbol: "TOKEN", decimals: 18 };
    try { info = await fetchTokenInfo(provider, normAddr(token)); } catch {}

    state.set(tgId, { token: normAddr(token), symbol: info.symbol, decimals: info.decimals });

    // keep pos metadata nice
    const { all, k, pos } = getPos(normAddr(token));
    pos.symbol = info.symbol;
    pos.decimals = info.decimals;
    all[k] = pos;
    savePositionsAll(all);

    await upsertStatus(ctx, tgId);
    return;
  }

  // amount
  if (mode === "amount") {
    const n = Number(text.replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return ctx.reply("❌ Invalid number.");
    const s = getUserSettings(tgId);
    s.buyPls = String(n);
    setUserSettings(tgId, s);
    awaiting.delete(tgId);
    await upsertStatus(ctx, tgId);
    return;
  }

  // gas
  if (mode === "gas") {
    const n = Number(text.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 21000) return ctx.reply("❌ Invalid gas limit.");
    const s = getUserSettings(tgId);
    s.gasLimit = String(Math.floor(n));
    setUserSettings(tgId, s);
    awaiting.delete(tgId);
    await upsertStatus(ctx, tgId);
    return;
  }

  // fees
  if (mode === "fees") {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const s = getUserSettings(tgId);

    const next = { NORMAL: null, FAST: null, AGGRO: null };
    let active = null;

    for (const ln of lines) {
      const parts = ln.split(/\s+/);
      if (parts[0]?.toUpperCase() === "ACTIVE" && parts[1]) {
        active = parts[1].toUpperCase();
        continue;
      }
      const k = parts[0]?.toUpperCase();
      const maxF = parts[1];
      const prio = parts[2];
      if (!["NORMAL", "FAST", "AGGRO"].includes(k)) continue;
      if (!Number.isFinite(Number(maxF)) || !Number.isFinite(Number(prio))) continue;
      next[k] = { maxFeeGwei: String(maxF), prioFeeGwei: String(prio) };
    }

    if (!next.NORMAL || !next.FAST || !next.AGGRO) {
      return ctx.reply("❌ Invalid format.\nExample:\nNORMAL 25 2\nFAST 40 4\nAGGRO 65 7\nACTIVE FAST");
    }

    s.feePresets = next;
    if (active && ["NORMAL", "FAST", "AGGRO"].includes(active)) s.activeFee = active;

    setUserSettings(tgId, s);
    awaiting.delete(tgId);
    await upsertStatus(ctx, tgId);
    return;
  }

  // quick amounts
  if (mode === "qamounts") {
    const lines = text.split("\n").map((l) => l.replace(/,/g, "").trim()).filter(Boolean);
    if (lines.length < 3) return ctx.reply("❌ Send at least 3 numbers (one per line).");

    const nums = lines.map((n) => Number(n));
    if (nums.some((n) => !Number.isFinite(n) || n <= 0)) {
      return ctx.reply("❌ Invalid number detected. Example:\n2000000\n5000000\n10000000\n15000000\n20000000");
    }

    const s = getUserSettings(tgId);
    s.quickBuyAmounts = nums.map((n) => String(Math.floor(n)));
    setUserSettings(tgId, s);

    awaiting.delete(tgId);
    await upsertStatus(ctx, tgId);
    return;
  }

  return ctx.reply("Use the buttons or paste a token address.");
});

/* ===================== LAUNCH ===================== */
console.log("DEBUG: launching bot");

// start watcher before launch
startPendingWatcher();

bot.launch({ dropPendingUpdates: true })
  .then(() => console.log("✅ Telegram bot started"))
  .catch((err) => console.error("❌ Launch error:", err));

process.on("unhandledRejection", (reason) => console.error("❌ Unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("❌ Uncaught exception:", err));
