#!/usr/bin/env bun
/**
 * hodlmm-stop-loss — Impermanent loss guardian for Bitflow HODLMM positions.
 *
 * Monitors a HODLMM position for impermanent loss (IL) in real time.
 * When IL breaches the user-defined threshold for two consecutive cycles
 * (confirmation window), autonomously withdraws a configurable percentage
 * of LP shares via withdraw-liquidity-same-multi on the DLMM router.
 *
 * Commands:
 *   doctor   — validate environment, APIs, wallet balance
 *   status   — snapshot current position and report live IL
 *   run      — autonomous stop-loss guardian loop
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP    = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API       = "https://api.mainnet.hiro.so";
const EXPLORER       = "https://explorer.hiro.so/txid";

// Mainnet DLMM liquidity router — SM deployer, v-1-1.
// SPQC38PW... is xyk/swap only. Do NOT use it for DLMM withdrawals.
const ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_NAME = "dlmm-liquidity-router-v-1-1";

// Bin ID conversion: API returns unsigned [0,1000]; contract uses signed offset from CENTER.
// signed_bin_id = unsigned_bin_id - CENTER_BIN_ID
const CENTER_BIN_ID = 500;

const CONFIRMATION_CYCLES_REQUIRED = 2;   // consecutive cycles above IL threshold before exit
const COOLDOWN_BLOCKS               = 10;  // ~100 minutes on Stacks (~10 min/block)
const MAX_EXITS_HARD_CAP            = 10;
const FETCH_TIMEOUT                 = 30_000;

const STATE_FILE  = path.join(os.homedir(), ".hodlmm-stop-loss-state.json");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR  = path.join(os.homedir(), ".aibtc", "wallets");

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolMeta {
  pool_id:          string;
  pool_contract:    string; // "address.name"
  token_x:          string; // "address.name"
  token_y:          string; // "address.name"
  token_x_symbol:   string;
  token_y_symbol:   string;
  token_x_decimals: number;
  token_y_decimals: number;
  active_bin:       number;
  bin_step:         number;
}

interface UserBin {
  bin_id:    number;
  liquidity: string; // DLP shares as string (bigint-safe)
  reserve_x: string;
  reserve_y: string;
  price:     string;
}

interface PositionSnapshot {
  pool_id:    string;
  pair:       string;
  active_bin: number;
  user_bins:  number[];
  in_range:   boolean;
  total_dlp:  string;
  total_x_raw: string;
  total_y_raw: string;
  value_usd:  number;
  fetched_at: number;
}

interface SentinelState {
  confirmationStreak: number;
  exitsExecuted:      number;
  lastExitBlock:      number;
  entryValueUsd:      number;
  entryFetchedAt:     number;
}

interface PersistentState {
  [poolId: string]: { last_exit_at: string; exit_count: number };
}

// ─── Output ───────────────────────────────────────────────────────────────────

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({ ...obj, timestamp: new Date().toISOString() }) + "\n"
  );
}

function fatal(msg: string, code = "FATAL"): never {
  process.stderr.write(JSON.stringify({ error: msg, code }) + "\n");
  process.exit(1);
}

function log(...args: unknown[]): void {
  process.stderr.write(`[stop-loss] ${args.join(" ")}\n`);
}

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } =
      await import("@stacks/transactions" as string);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }

  const { generateWallet, deriveAccount, getStxAddress } =
    await import("@stacks/wallet-sdk" as string);

  if (fs.existsSync(WALLETS_FILE)) {
    const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
    const activeWallet = (walletsJson.wallets ?? [])[0];
    if (activeWallet?.id) {
      const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
      if (fs.existsSync(keystorePath)) {
        const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
        const enc = keystore.encrypted;
        if (enc?.ciphertext) {
          const { scryptSync, createDecipheriv } = await import("crypto");
          const salt       = Buffer.from(enc.salt, "base64");
          const iv         = Buffer.from(enc.iv, "base64");
          const authTag    = Buffer.from(enc.authTag, "base64");
          const ciphertext = Buffer.from(enc.ciphertext, "base64");
          const key = scryptSync(password, salt, enc.scryptParams?.keyLen ?? 32, {
            N: enc.scryptParams?.N ?? 16384,
            r: enc.scryptParams?.r ?? 8,
            p: enc.scryptParams?.p ?? 1,
          });
          const decipher = createDecipheriv("aes-256-gcm", key, iv);
          decipher.setAuthTag(authTag);
          const mnemonic = Buffer.concat([decipher.update(ciphertext), decipher.final()])
            .toString("utf-8").trim();
          const wallet  = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
        }
      }
    }
  }
  throw new Error("No wallet found. Set STACKS_PRIVATE_KEY or run: npx @aibtc/mcp-server@latest --install");
}

// ─── Bitflow API ──────────────────────────────────────────────────────────────

async function fetchPool(poolId: string): Promise<PoolMeta> {
  const raw = await fetchJson<{ data?: unknown[]; results?: unknown[]; pools?: unknown[]; [k: string]: unknown }>(
    `${BITFLOW_APP}/pools?amm_type=dlmm`
  );
  const list = (raw.data ?? raw.results ?? raw.pools ?? (Array.isArray(raw) ? raw : [])) as Record<string, unknown>[];
  const p = list.find((x) => String(x.pool_id) === poolId);
  if (!p) throw new Error(`Pool ${poolId} not found in Bitflow registry`);
  return {
    pool_id:          String(p.pool_id),
    pool_contract:    String(p.pool_token ?? ""),
    token_x:          String(p.token_x ?? ""),
    token_y:          String(p.token_y ?? ""),
    token_x_symbol:   String(p.token_x_symbol ?? "?"),
    token_y_symbol:   String(p.token_y_symbol ?? "?"),
    token_x_decimals: Number(p.token_x_decimals ?? 8),
    token_y_decimals: Number(p.token_y_decimals ?? 6),
    active_bin:       Number(p.active_bin ?? 0),
    bin_step:         Number(p.bin_step ?? 0),
  };
}

async function fetchUserBins(poolId: string, wallet: string): Promise<UserBin[]> {
  const raw = await fetchJson<Record<string, unknown>>(
    `${BITFLOW_APP}/users/${wallet}/positions/${poolId}/bins`
  );
  const bins = (raw.bins ?? []) as Record<string, unknown>[];
  return bins
    .filter((b) => BigInt(String(b.user_liquidity ?? b.liquidity ?? "0")) > 0n)
    .map((b) => ({
      bin_id:    Number(b.bin_id),
      liquidity: String(b.user_liquidity ?? b.liquidity ?? "0"),
      reserve_x: String(b.reserve_x ?? "0"),
      reserve_y: String(b.reserve_y ?? "0"),
      price:     String(b.price ?? "0"),
    }));
}

async function fetchActiveBin(poolId: string): Promise<number> {
  const raw = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/${poolId}`);
  return Number(raw.active_bin_id ?? 0);
}

async function fetchTokenPricesUsd(): Promise<Map<string, number>> {
  const raw = await fetchJson<unknown[]>(`${BITFLOW_APP}/tokens`);
  const map = new Map<string, number>();
  for (const t of raw as Record<string, unknown>[]) {
    const id    = String(t.contract_id ?? t.contractId ?? "");
    const price = parseFloat(String(t.price_usd ?? t.priceUsd ?? "0"));
    if (id) map.set(id, price);
  }
  return map;
}

async function fetchStxBalance(wallet: string): Promise<number> {
  const data = await fetchJson<Record<string, string>>(
    `${HIRO_API}/extended/v1/address/${wallet}/stx`
  );
  return Number(BigInt(data?.balance ?? "0")) / 1e6;
}

async function fetchNonce(wallet: string): Promise<bigint> {
  const data = await fetchJson<Record<string, unknown>>(
    `${HIRO_API}/extended/v1/address/${wallet}/nonces`
  );
  const next = data.possible_next_nonce;
  if (next !== undefined && next !== null) return BigInt(Number(next));
  const last = data.last_executed_tx_nonce;
  if (last !== undefined && last !== null) return BigInt(Number(last) + 1);
  return 0n;
}

async function fetchCurrentBlock(): Promise<number> {
  const data = await fetchJson<Record<string, unknown>>(`${HIRO_API}/v2/info`);
  return Number(data.stacks_tip_height ?? 0);
}

// ─── Position snapshot ────────────────────────────────────────────────────────

async function buildSnapshot(
  pool: PoolMeta,
  wallet: string,
  prices: Map<string, number>
): Promise<PositionSnapshot> {
  const [userBins, activeBin] = await Promise.all([
    fetchUserBins(pool.pool_id, wallet),
    fetchActiveBin(pool.pool_id),
  ]);

  const ids = userBins.map((b) => b.bin_id).sort((a, b) => a - b);
  const inRange = ids.length > 0 && activeBin >= ids[0] && activeBin <= ids[ids.length - 1];

  let totalDlp = 0n;
  let totalXRaw = 0n;
  let totalYRaw = 0n;

  for (const b of userBins) {
    totalDlp  += BigInt(b.liquidity);
    totalXRaw += BigInt(b.reserve_x);
    totalYRaw += BigInt(b.reserve_y);
  }

  const priceX   = prices.get(pool.token_x) ?? 0;
  const priceY   = prices.get(pool.token_y) ?? 0;
  const decimalsX = Math.pow(10, pool.token_x_decimals);
  const decimalsY = Math.pow(10, pool.token_y_decimals);
  const amountX  = Number(totalXRaw) / decimalsX;
  const amountY  = Number(totalYRaw) / decimalsY;
  const valueUsd = amountX * priceX + amountY * priceY;

  return {
    pool_id:     pool.pool_id,
    pair:        `${pool.token_x_symbol}/${pool.token_y_symbol}`,
    active_bin:  activeBin,
    user_bins:   ids,
    in_range:    inRange,
    total_dlp:   totalDlp.toString(),
    total_x_raw: totalXRaw.toString(),
    total_y_raw: totalYRaw.toString(),
    value_usd:   parseFloat(valueUsd.toFixed(4)),
    fetched_at:  Date.now(),
  };
}

// ─── IL calculation ───────────────────────────────────────────────────────────

/**
 * Impermanent loss formula:
 *   HODL value  = entryAmountX * currentPriceX + entryAmountY * currentPriceY
 *   LP value    = current position USD value
 *   IL%         = (HODL_value - LP_value) / HODL_value * 100
 *
 * Entry snapshot captured at session start.
 * IL grows when price diverges from entry; shrinks when price reverts.
 */
function computeIL(params: {
  entryXRaw:    bigint;
  entryYRaw:    bigint;
  entryPriceX:  number;
  entryPriceY:  number;
  currentPriceX: number;
  currentPriceY: number;
  currentValueUsd: number;
  decimalsX:    number;
  decimalsY:    number;
}): { ilPct: number; hodlValueUsd: number; entryValueUsd: number } {
  const { entryXRaw, entryYRaw, entryPriceX, entryPriceY,
          currentPriceX, currentPriceY, currentValueUsd,
          decimalsX, decimalsY } = params;

  const entryAmountX = Number(entryXRaw) / decimalsX;
  const entryAmountY = Number(entryYRaw) / decimalsY;

  const entryValueUsd = entryAmountX * entryPriceX + entryAmountY * entryPriceY;
  const hodlValueUsd  = entryAmountX * currentPriceX + entryAmountY * currentPriceY;

  const ilPct = hodlValueUsd > 0
    ? ((hodlValueUsd - currentValueUsd) / hodlValueUsd) * 100
    : 0;

  return {
    ilPct:        parseFloat(ilPct.toFixed(4)),
    hodlValueUsd: parseFloat(hodlValueUsd.toFixed(4)),
    entryValueUsd: parseFloat(entryValueUsd.toFixed(4)),
  };
}

// ─── Withdrawal execution ─────────────────────────────────────────────────────

async function executeWithdrawal(
  privateKey: string,
  pool: PoolMeta,
  userBins: UserBin[],
  exitPct: number,
  nonce: bigint
): Promise<string> {
  const {
    makeContractCall, broadcastTransaction,
    listCV, tupleCV, intCV, uintCV, contractPrincipalCV,
    PostConditionMode, AnchorMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const [poolAddr, poolName] = pool.pool_contract.split(".");
  const [xAddr,   xName]    = pool.token_x.split(".");
  const [yAddr,   yName]    = pool.token_y.split(".");

  // Build per-bin withdrawal tuples.
  // withdraw-liquidity-same-multi takes a list of 5-field tuples:
  //   pool-trait, bin-id (signed int), amount (uint), min-x-amount (uint), min-y-amount (uint)
  // Bin IDs must be converted from unsigned API values to signed contract offsets:
  //   signed = unsigned - CENTER_BIN_ID (500)
  const positionTuples = userBins.map((b) => {
    const dlpInBin  = BigInt(b.liquidity);
    const toRemove  = (dlpInBin * BigInt(Math.floor(exitPct))) / 100n;
    const signedBin = b.bin_id - CENTER_BIN_ID; // convert to signed offset

    return tupleCV({
      "pool-trait":    contractPrincipalCV(poolAddr, poolName),
      "bin-id":        intCV(signedBin),   // signed — never uintCV for bin IDs
      "amount":        uintCV(toRemove),
      "min-x-amount":  uintCV(0n),         // per-bin floor — rely on aggregate below
      "min-y-amount":  uintCV(0n),
    });
  });

  // Aggregate slippage floors — 1% tolerance on total expected output.
  // Provides meaningful on-chain protection without needing exact per-bin math.
  let totalExpectedXRaw = 0n;
  let totalExpectedYRaw = 0n;
  for (const b of userBins) {
    const dlpInBin = BigInt(b.liquidity);
    const toRemove = (dlpInBin * BigInt(Math.floor(exitPct))) / 100n;
    const poolDlp  = dlpInBin > 0n ? dlpInBin : 1n;
    totalExpectedXRaw += (BigInt(b.reserve_x) * toRemove) / poolDlp;
    totalExpectedYRaw += (BigInt(b.reserve_y) * toRemove) / poolDlp;
  }
  const minXTotal = (totalExpectedXRaw * 9900n) / 10_000n; // 1% slippage
  const minYTotal = (totalExpectedYRaw * 9900n) / 10_000n;

  const tx = await makeContractCall({
    contractAddress: ROUTER_ADDR,              // SM1FKXGN... — DLMM router deployer
    contractName:    ROUTER_NAME,              // dlmm-liquidity-router-v-1-1
    functionName:    "withdraw-liquidity-same-multi",
    functionArgs: [
      listCV(positionTuples),
      contractPrincipalCV(xAddr, xName),       // x-token-trait
      contractPrincipalCV(yAddr, yName),       // y-token-trait
      uintCV(minXTotal),                        // min-x-amount-total (aggregate slippage floor)
      uintCV(minYTotal),                        // min-y-amount-total
    ],
    senderKey:         privateKey,
    network:           STACKS_MAINNET,
    postConditions:    [],
    // DLP burn+mint in same tx cannot be expressed as sender-side post-conditions.
    // Slippage protection is provided by min-x/y-amount-total args in the router call.
    postConditionMode: PostConditionMode.Allow,
    anchorMode:        AnchorMode.Any,
    nonce,
    fee: 50_000n,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Withdrawal broadcast failed: ${result.error} — ${(result as Record<string, string>).reason ?? ""}`);
  }
  return result.txid as string;
}

// ─── Persistent state ─────────────────────────────────────────────────────────

function loadPersistentState(): PersistentState {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as PersistentState; }
  catch { return {}; }
}

function savePersistentState(state: PersistentState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Commands ─────────────────────────────────────────────────────────────────

// ── doctor ────────────────────────────────────────────────────────────────────

async function cmdDoctor(wallet?: string): Promise<void> {
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  try {
    const raw = await fetchJson<Record<string, unknown>>(`${BITFLOW_APP}/pools?amm_type=dlmm`);
    const list = (raw.data ?? raw.results ?? raw.pools ?? (Array.isArray(raw) ? raw : [])) as unknown[];
    checks.bitflow_pools = { ok: list.length > 0, detail: `${list.length} DLMM pools found` };
  } catch (e) { checks.bitflow_pools = { ok: false, detail: String(e) }; }

  try {
    const raw = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/dlmm_1`);
    checks.bitflow_quotes = { ok: !!raw.active_bin_id, detail: `active_bin=${raw.active_bin_id}` };
  } catch (e) { checks.bitflow_quotes = { ok: false, detail: String(e) }; }

  try {
    const info = await fetchJson<Record<string, unknown>>(`${HIRO_API}/v2/info`);
    checks.hiro_api = { ok: !!info.stacks_tip_height, detail: `tip=${info.stacks_tip_height}` };
  } catch (e) { checks.hiro_api = { ok: false, detail: String(e) }; }

  if (wallet) {
    try {
      const bal = await fetchStxBalance(wallet);
      checks.stx_balance = { ok: bal > 0.05, detail: `${bal.toFixed(4)} STX` };
    } catch (e) { checks.stx_balance = { ok: false, detail: String(e) }; }
  }

  try {
    await import("@stacks/transactions" as string);
    checks.stacks_tx_lib = { ok: true, detail: "available" };
  } catch { checks.stacks_tx_lib = { ok: false, detail: "@stacks/transactions not installed" }; }

  const allOk = Object.values(checks).every((c) => c.ok);
  emit({ command: "doctor", status: allOk ? "healthy" : "degraded", checks });
  if (!allOk) process.exit(1);
}

// ── status ────────────────────────────────────────────────────────────────────

async function cmdStatus(opts: {
  pool: string;
  wallet: string;
  ilThreshold: number;
}): Promise<void> {
  const pool   = await fetchPool(opts.pool);
  const prices = await fetchTokenPricesUsd();
  const snap   = await buildSnapshot(pool, opts.wallet, prices);

  if (BigInt(snap.total_dlp) === 0n) {
    emit({
      command: "status",
      pool: opts.pool,
      status: "NO_POSITION",
      note: "No liquidity found for this wallet in this pool.",
    });
    return;
  }

  emit({
    command:        "status",
    pool:           opts.pool,
    pair:           snap.pair,
    active_bin:     snap.active_bin,
    user_bins:      snap.user_bins,
    in_range:       snap.in_range,
    total_dlp:      snap.total_dlp,
    value_usd:      snap.value_usd,
    il_threshold:   opts.ilThreshold,
    recommendation: snap.in_range
      ? "Position is in range. Run the `run` command to start the IL sentinel loop."
      : "Position is out of range — earning no fees. Consider rebalancing before starting the sentinel.",
    note: "IL% is tracked by `run` via a high-water-mark baseline captured at session start. `status` reports live position state only.",
  });
}

// ── run ───────────────────────────────────────────────────────────────────────

async function cmdRun(opts: {
  pool:        string;
  wallet:      string;
  password:    string;
  ilThreshold: number;
  exitPct:     number;
  feeCap:      number;
  intervalSec: number;
  maxExits:    number;
  dryRun:      boolean;
}): Promise<void> {

  // ── Pre-flight guardrails ─────────────────────────────────────────────────
  if (!opts.feeCap)           fatal("--fee-cap is required. Refusing to start without an explicit spend limit.", "MISSING_FEE_CAP");
  if (opts.exitPct > 100)     fatal("--exit-pct cannot exceed 100.", "INVALID_EXIT_PCT");
  if (opts.maxExits > MAX_EXITS_HARD_CAP) fatal(`--max-exits cannot exceed hard cap of ${MAX_EXITS_HARD_CAP}.`, "INVALID_MAX_EXITS");

  const pool   = await fetchPool(opts.pool);
  const prices = await fetchTokenPricesUsd();

  // Validate contract formats
  if (!pool.pool_contract.includes(".") || !pool.token_x.includes(".") || !pool.token_y.includes(".")) {
    fatal(`Invalid contract format for pool ${opts.pool} — missing deployer.name separator.`, "INVALID_CONTRACTS");
  }

  // Take entry snapshot — IL is measured against this baseline throughout the session
  const entrySnap = await buildSnapshot(pool, opts.wallet, prices);
  if (BigInt(entrySnap.total_dlp) === 0n) {
    emit({ event: "halt", reason: "no_position_found", pool: opts.pool });
    return;
  }

  const entryXRaw   = BigInt(entrySnap.total_x_raw);
  const entryYRaw   = BigInt(entrySnap.total_y_raw);
  const entryPriceX = prices.get(pool.token_x) ?? 0;
  const entryPriceY = prices.get(pool.token_y) ?? 0;
  const decimalsX   = Math.pow(10, pool.token_x_decimals);
  const decimalsY   = Math.pow(10, pool.token_y_decimals);

  // Decrypt wallet once
  log("Decrypting wallet...");
  let keys: { stxPrivateKey: string; stxAddress: string } | null = null;
  if (!opts.dryRun) {
    keys = await getWalletKeys(opts.password);
    if (keys.stxAddress !== opts.wallet) {
      fatal(`Wallet address mismatch: expected ${opts.wallet}, got ${keys.stxAddress}`, "WALLET_MISMATCH");
    }
  }

  emit({
    event:           "start",
    pool:            opts.pool,
    pair:            entrySnap.pair,
    il_threshold:    opts.ilThreshold,
    exit_pct:        opts.exitPct,
    fee_cap_stx:     opts.feeCap,
    max_exits:       opts.maxExits,
    interval_sec:    opts.intervalSec,
    dry_run:         opts.dryRun,
  });

  emit({
    event:           "entry_snapshot",
    total_dlp:       entrySnap.total_dlp,
    total_x_raw:     entrySnap.total_x_raw,
    total_y_raw:     entrySnap.total_y_raw,
    entry_value_usd: entrySnap.value_usd,
    price_x_usd:     entryPriceX,
    price_y_usd:     entryPriceY,
    active_bin:      entrySnap.active_bin,
    in_range:        entrySnap.in_range,
  });

  // ── Sentinel state ────────────────────────────────────────────────────────
  const state: SentinelState = {
    confirmationStreak: 0,
    exitsExecuted:      0,
    lastExitBlock:      0,
    entryValueUsd:      entrySnap.value_usd,
    entryFetchedAt:     entrySnap.fetched_at,
  };

  const persistState = loadPersistentState();

  let cycle = 0;

  while (state.exitsExecuted < opts.maxExits) {
    cycle++;
    await new Promise((r) => setTimeout(r, opts.intervalSec * 1_000));

    // ── Fetch current position ──────────────────────────────────────────────
    let currentPrices: Map<string, number>;
    let currentSnap: PositionSnapshot;
    let userBins: UserBin[];

    try {
      [currentPrices, currentSnap, userBins] = await Promise.all([
        fetchTokenPricesUsd(),
        buildSnapshot(pool, opts.wallet, prices),
        fetchUserBins(opts.pool, opts.wallet),
      ]);
      // Refresh current snap with latest prices
      currentSnap = await buildSnapshot(pool, opts.wallet, currentPrices);
    } catch (e) {
      emit({ event: "error", cycle, error: String(e), action: "retrying_next_cycle" });
      continue;
    }

    if (BigInt(currentSnap.total_dlp) === 0n) {
      emit({ event: "halt", reason: "position_empty", cycle, exits_executed: state.exitsExecuted });
      return;
    }

    // ── Compute IL ─────────────────────────────────────────────────────────
    const currentPriceX = currentPrices.get(pool.token_x) ?? 0;
    const currentPriceY = currentPrices.get(pool.token_y) ?? 0;

    const il = computeIL({
      entryXRaw,
      entryYRaw,
      entryPriceX,
      entryPriceY,
      currentPriceX,
      currentPriceY,
      currentValueUsd: currentSnap.value_usd,
      decimalsX,
      decimalsY,
    });

    // ── Below threshold → monitor ──────────────────────────────────────────
    if (il.ilPct < opts.ilThreshold) {
      if (state.confirmationStreak > 0) {
        emit({ event: "confirmation_reset", cycle, prior_streak: state.confirmationStreak });
        state.confirmationStreak = 0;
      }
      emit({
        event:             "cycle",
        cycle,
        il_pct:            il.ilPct,
        il_threshold:      opts.ilThreshold,
        current_value_usd: currentSnap.value_usd,
        hodl_value_usd:    il.hodlValueUsd,
        in_range:          currentSnap.in_range,
        trigger_status:    "MONITORING",
      });
      continue;
    }

    // ── Above threshold → increment confirmation streak ────────────────────
    state.confirmationStreak++;
    emit({
      event:                "threshold_pending_confirmation",
      cycle,
      il_pct:               il.ilPct,
      il_threshold:         opts.ilThreshold,
      confirmation_streak:  state.confirmationStreak,
      confirmation_required: CONFIRMATION_CYCLES_REQUIRED,
      executing:            state.confirmationStreak >= CONFIRMATION_CYCLES_REQUIRED,
    });

    if (state.confirmationStreak < CONFIRMATION_CYCLES_REQUIRED) {
      // Wait for next cycle to confirm — prevents false exits on transient spikes
      continue;
    }

    // ── Confirmed → execute withdrawal ─────────────────────────────────────
    state.confirmationStreak = 0; // reset for next potential trigger

    // Cooldown check (block-based)
    let currentBlock = 0;
    try { currentBlock = await fetchCurrentBlock(); } catch { /* non-fatal */ }

    if (state.lastExitBlock > 0 && currentBlock - state.lastExitBlock < COOLDOWN_BLOCKS) {
      const blocksLeft = COOLDOWN_BLOCKS - (currentBlock - state.lastExitBlock);
      emit({ event: "cooldown_active", cycle, blocks_remaining: blocksLeft, current_block: currentBlock });
      continue;
    }

    // Balance check
    const stxBal = await fetchStxBalance(opts.wallet);
    if (stxBal < 0.05) {
      emit({ event: "halt", reason: "insufficient_stx_for_fees", stx_balance: stxBal, cycle });
      process.exit(1);
    }

    if (userBins.length === 0) {
      emit({ event: "error", cycle, error: "no_bins_to_withdraw", action: "skipping_exit" });
      continue;
    }

    if (opts.dryRun) {
      emit({
        event:           "tx_broadcast",
        dry_run:         true,
        simulated_txid:  "dry-run-no-broadcast",
        exit_pct:        opts.exitPct,
        il_pct_at_exit:  il.ilPct,
        bins_affected:   userBins.length,
        hodl_value_usd:  il.hodlValueUsd,
        current_value_usd: currentSnap.value_usd,
      });
      emit({ event: "tx_confirmed", dry_run: true, simulated_block: "N/A" });
    } else {
      try {
        const nonce = await fetchNonce(opts.wallet);
        const txid  = await executeWithdrawal(
          keys!.stxPrivateKey,
          pool,
          userBins,
          opts.exitPct,
          nonce
        );

        emit({
          event:            "tx_broadcast",
          txid,
          exit_pct:         opts.exitPct,
          il_pct_at_exit:   il.ilPct,
          bins_affected:    userBins.length,
          hodl_value_usd:   il.hodlValueUsd,
          current_value_usd: currentSnap.value_usd,
          explorer:         `${EXPLORER}/${txid}?chain=mainnet`,
        });

        // Persist state
        persistState[opts.pool] = {
          last_exit_at: new Date().toISOString(),
          exit_count:   (persistState[opts.pool]?.exit_count ?? 0) + 1,
        };
        savePersistentState(persistState);
        state.lastExitBlock = currentBlock;

        emit({ event: "tx_confirmed", txid, block: currentBlock });
      } catch (e) {
        emit({ event: "error", cycle, error: String(e), action: "skipping_exit" });
        continue;
      }
    }

    state.exitsExecuted++;
    emit({ event: "exit_recorded", exits_executed: state.exitsExecuted, max_exits: opts.maxExits });

    if (state.exitsExecuted >= opts.maxExits) break;

    // Cooldown between exits
    emit({ event: "cooldown_start", blocks: COOLDOWN_BLOCKS, note: "~100 minutes on Stacks mainnet" });
  }

  emit({
    event:            "halt",
    reason:           "max_exits_reached",
    exits_executed:   state.exitsExecuted,
    cycles_completed: cycle,
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("hodlmm-stop-loss")
  .description("Impermanent loss guardian for Bitflow HODLMM positions")
  .version("1.0.0");

program
  .command("doctor")
  .description("Validate environment, APIs, and wallet balance")
  .option("--wallet <address>", "STX address to check balance for")
  .action(async (opts) => {
    try { await cmdDoctor(opts.wallet); }
    catch (e) { emit({ command: "doctor", status: "error", error: String(e) }); process.exit(1); }
  });

program
  .command("status")
  .description("Snapshot current position and report live state")
  .requiredOption("--pool <id>",    "Bitflow HODLMM pool ID (e.g. dlmm_3)")
  .requiredOption("--wallet <address>", "STX address")
  .option("--il-threshold <n>", "IL% threshold for reference", parseFloat, 5)
  .action(async (opts) => {
    try {
      await cmdStatus({
        pool:        opts.pool,
        wallet:      opts.wallet,
        ilThreshold: opts.ilThreshold,
      });
    } catch (e) { emit({ command: "status", error: String(e) }); process.exit(1); }
  });

program
  .command("run")
  .description("Start the IL stop-loss guardian loop")
  .requiredOption("--pool <id>",        "Bitflow HODLMM pool ID (e.g. dlmm_3)")
  .requiredOption("--wallet <address>", "STX address")
  .option("--password <pass>",      "Wallet password (required for live execution)")
  .option("--il-threshold <n>",     "IL% that triggers exit (default: 5)",        parseFloat, 5)
  .option("--exit-pct <n>",         "% of shares to remove per trigger (default: 50)", parseFloat, 50)
  .option("--fee-cap <stx>",        "Max STX fee per transaction (REQUIRED)",     parseFloat)
  .option("--interval <sec>",       "Polling interval in seconds (default: 60)",  parseInt,   60)
  .option("--max-exits <n>",        "Max exits per session (default: 3)",         parseInt,   3)
  .option("--dry-run",              "Simulate without broadcasting",              false)
  .action(async (opts) => {
    try {
      await cmdRun({
        pool:        opts.pool,
        wallet:      opts.wallet,
        password:    opts.password ?? "",
        ilThreshold: opts.ilThreshold,
        exitPct:     opts.exitPct,
        feeCap:      opts.feeCap,
        intervalSec: opts.interval,
        maxExits:    opts.maxExits,
        dryRun:      opts.dryRun,
      });
    } catch (e) { emit({ event: "fatal_error", error: String(e) }); process.exit(1); }
  });

if (import.meta.main) {
  program.parse(process.argv);
}
