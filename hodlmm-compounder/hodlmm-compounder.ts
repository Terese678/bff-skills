#!/usr/bin/env bun
import { Command } from "commander";
import {
  makeContractCall,
  broadcastTransaction,
  uintCV,
  intCV,
  listCV,
  tupleCV,
  contractPrincipalCV,
  createAssetInfo,
  makeStandardFungiblePostCondition,
  makeContractFungiblePostCondition,
  FungibleConditionCode,
  PostConditionMode,
  AnchorMode,
} from "@stacks/transactions";
import { StacksMainnet } from "@stacks/network";

// ─── Constants ────────────────────────────────────────────────────────────────

const BFF_API_URL = "https://bff.bitflowapis.finance/api";
const STACKS_API = "https://api.hiro.so";
const LIQUIDITY_ROUTER_CONTRACT =
  "SP3ESW1QCNQPVXJDGQWT7E45RDCH38QBK9HEJSX4X.dlmm-liquidity-router-v-0-1";
const RATE_LIMIT_MS = 10_000;
const COOLDOWN_MS = 3_600_000;
// FIX 1: MAX_COMPOUNDS unified — was 20 in code but 24 in AGENT.md. Now 20 everywhere.
const MAX_COMPOUNDS = 20;
const DEFAULT_MAX_SLIPPAGE = 0.01;
const DEFAULT_MIN_THRESHOLD = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 3_600_000;
const TX_CONFIRM_POLL_MS = 10_000;
const TX_CONFIRM_TIMEOUT_MS = 300_000;

// Bin ID midpoint offset — Bitflow stores unsigned bin IDs offset by 2^23
const BIN_ID_MIDPOINT = 8_388_608;
function toSignedBinId(unsignedBinId: number): number {
  return unsignedBinId - BIN_ID_MIDPOINT;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PositionBin {
  bin_id: number;
  user_liquidity: number;
  liquidity: number;
  reserve_x: number;
  reserve_y: number;
  accumulated_fee_x?: number;
  accumulated_fee_y?: number;
}

interface PoolData {
  pool_id: string;
  active_bin_id: number;
  x_token: string;
  y_token: string;
  pool_contract: string;
  x_protocol_fee: number;
  x_provider_fee: number;
  x_variable_fee: number;
  y_protocol_fee: number;
  y_provider_fee: number;
  y_variable_fee: number;
  // DLP/reserve ratio fields for min-dlp calculation
  total_supply?: number;
  reserve_x?: number;
  reserve_y?: number;
}

interface CompoundStatus {
  poolId: string;
  totalLiquidity: number;
  accumulatedFeesX: number;
  accumulatedFeesY: number;
  compoundThresholdMet: boolean;
  estimatedCompoundBoostBps: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let lastApiCallTime = 0;

async function rateLimitedFetch(url: string, options?: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastApiCallTime;
  if (elapsed < RATE_LIMIT_MS) await sleep(RATE_LIMIT_MS - elapsed);
  lastApiCallTime = Date.now();
  const res = await fetch(url, options);
  if (res.status === 429) {
    await sleep(30_000);
    return rateLimitedFetch(url, options);
  }
  return res;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function out(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function ts(): number {
  return Math.floor(Date.now() / 1000);
}

async function loadWallet(): Promise<{ address: string; privateKey: string }> {
  const address =
    process.env.STACKS_ADDRESS ??
    process.env.AIBTC_STACKS_ADDRESS ??
    process.env.WALLET_ADDRESS;
  const privateKey =
    process.env.STACKS_PRIVATE_KEY ?? process.env.AIBTC_STACKS_PRIVATE_KEY;
  if (!address) throw new Error("No wallet address found. Set STACKS_ADDRESS env var.");
  if (!privateKey) throw new Error("No private key found. Set STACKS_PRIVATE_KEY env var.");
  return { address, privateKey };
}

// ─── Bitflow API ──────────────────────────────────────────────────────────────

function bffHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.BFF_API_KEY;
  if (apiKey) headers["X-API-Key"] = apiKey;
  return headers;
}

async function fetchPoolData(poolId: string): Promise<PoolData | null> {
  try {
    const res = await rateLimitedFetch(`${BFF_API_URL}/app/v1/pools/${poolId}`, { headers: bffHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Pool API error: ${res.status}`);
    return (await res.json()) as PoolData;
  } catch {
    return null;
  }
}

async function fetchUserPositionBins(userAddress: string, poolId: string): Promise<PositionBin[]> {
  const res = await rateLimitedFetch(
    `${BFF_API_URL}/app/v1/users/${userAddress}/positions/${poolId}/bins`,
    { headers: bffHeaders() }
  );
  if (!res.ok) throw new Error(`Position bins API error: ${res.status}`);
  const data = await res.json();
  return (data.bins ?? []) as PositionBin[];
}

async function getTokenAssetName(tokenContract: string): Promise<string> {
  const res = await rateLimitedFetch(`${BFF_API_URL}/quotes/v1/tokens`, { headers: bffHeaders() });
  if (!res.ok) throw new Error(`Tokens API error: ${res.status}`);
  const data = await res.json();
  const token = data.tokens?.find(
    (t: { contract_address: string; asset_name: string }) => t.contract_address === tokenContract
  );
  if (!token) throw new Error(`Token not found: ${tokenContract}`);
  return token.asset_name;
}

async function pollTxConfirmation(txId: string, timeoutMs = TX_CONFIRM_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${STACKS_API}/extended/v1/tx/${txId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.tx_status === "success") return true;
        if (data.tx_status === "abort_by_response" || data.tx_status === "abort_by_post_condition")
          throw new Error(`Transaction ${txId} failed: ${data.tx_status}`);
      }
    } catch { }
    await sleep(TX_CONFIRM_POLL_MS);
  }
  return false;
}

// ─── Compound logic ───────────────────────────────────────────────────────────

function calculateAccumulatedFees(bins: PositionBin[]): { totalFeesX: number; totalFeesY: number } {
  return bins.reduce(
    (acc, bin) => ({
      totalFeesX: acc.totalFeesX + (bin.accumulated_fee_x ?? 0),
      totalFeesY: acc.totalFeesY + (bin.accumulated_fee_y ?? 0),
    }),
    { totalFeesX: 0, totalFeesY: 0 }
  );
}

function calculateBinWithdrawalAmounts(
  bin: PositionBin,
  withdrawalPercentage: number,
  slippageTolerance = 1
): { liquidityToRemove: number; minXAmount: number; minYAmount: number } {
  if (bin.user_liquidity === 0 || bin.liquidity === 0)
    return { liquidityToRemove: 0, minXAmount: 0, minYAmount: 0 };
  const percentageDecimal = withdrawalPercentage / 100;
  const liquidityToRemove = Math.floor(bin.user_liquidity * percentageDecimal);
  const percentageOfBin = liquidityToRemove / bin.liquidity;
  const slippageMultiplier = 1 - slippageTolerance / 100;
  return {
    liquidityToRemove,
    minXAmount: Math.floor(bin.reserve_x * percentageOfBin * slippageMultiplier),
    minYAmount: Math.floor(bin.reserve_y * percentageOfBin * slippageMultiplier),
  };
}

// FIX 2: Compute expected DLP and apply slippage tolerance for real min-dlp protection
function computeMinDlp(
  harvestedX: number,
  harvestedY: number,
  poolTotalSupply: number,
  poolReserveX: number,
  poolReserveY: number,
  maxSlippage: number
): number {
  if (poolTotalSupply === 0 || (poolReserveX === 0 && poolReserveY === 0)) return 1;
  // Estimate DLP tokens from contributed reserves ratio
  const xRatio = poolReserveX > 0 ? harvestedX / poolReserveX : 0;
  const yRatio = poolReserveY > 0 ? harvestedY / poolReserveY : 0;
  const ratio = Math.min(xRatio, yRatio);
  const expectedDlp = Math.floor(ratio * poolTotalSupply);
  // Apply slippage tolerance — accept at least (1 - maxSlippage) of expected DLP
  const minDlp = Math.floor(expectedDlp * (1 - maxSlippage));
  return Math.max(minDlp, 1); // never zero
}

async function executeHarvest(
  poolData: PoolData,
  userBins: PositionBin[],
  walletAddress: string,
  privateKey: string,
  feeCap: number,
  slippageTolerance: number,
  dryRun: boolean
): Promise<{ txId: string | null; harvestedX: number; harvestedY: number }> {
  const network = new StacksMainnet();
  const routerAddress = LIQUIDITY_ROUTER_CONTRACT.split(".")[0];
  const routerName = LIQUIDITY_ROUTER_CONTRACT.split(".")[1];
  const poolContractAddress = poolData.pool_contract.split(".")[0];
  const poolContractName = poolData.pool_contract.split(".")[1];
  const xTokenAddress = poolData.x_token.split(".")[0];
  const xTokenName = poolData.x_token.split(".")[1];
  const yTokenAddress = poolData.y_token.split(".")[0];
  const yTokenName = poolData.y_token.split(".")[1];

  const xAssetName = await getTokenAssetName(poolData.x_token);
  const yAssetName = await getTokenAssetName(poolData.y_token);
  const xAssetInfo = createAssetInfo(xTokenAddress, xTokenName, xAssetName);
  const yAssetInfo = createAssetInfo(yTokenAddress, yTokenName, yAssetName);
  const poolAssetInfo = createAssetInfo(poolContractAddress, poolContractName, "pool-token");

  const binsToHarvest = userBins.filter(
    (b) => b.user_liquidity > 0 && ((b.accumulated_fee_x ?? 0) > 0 || (b.accumulated_fee_y ?? 0) > 0)
  );
  if (binsToHarvest.length === 0) throw new Error("No bins with accumulated fees to harvest");

  let totalLiquidityRemoved = 0;
  let totalMinX = 0;
  let totalMinY = 0;
  let harvestedX = 0;
  let harvestedY = 0;

  const binWithdrawalPositions = binsToHarvest.map((bin) => {
    const feeRatioX = bin.reserve_x > 0 ? (bin.accumulated_fee_x ?? 0) / bin.reserve_x : 0;
    const feeRatioY = bin.reserve_y > 0 ? (bin.accumulated_fee_y ?? 0) / bin.reserve_y : 0;
    const feeRatio = Math.max(feeRatioX, feeRatioY) * 100;
    const safePercentage = Math.min(feeRatio, 100);
    const amounts = calculateBinWithdrawalAmounts(bin, safePercentage, slippageTolerance * 100);
    totalLiquidityRemoved += amounts.liquidityToRemove;
    totalMinX += amounts.minXAmount;
    totalMinY += amounts.minYAmount;
    harvestedX += bin.accumulated_fee_x ?? 0;
    harvestedY += bin.accumulated_fee_y ?? 0;
    return tupleCV({
      "pool-trait": contractPrincipalCV(poolContractAddress, poolContractName),
      "x-token-trait": contractPrincipalCV(xTokenAddress, xTokenName),
      "y-token-trait": contractPrincipalCV(yTokenAddress, yTokenName),
      "bin-id": intCV(toSignedBinId(bin.bin_id)),
      amount: uintCV(amounts.liquidityToRemove),
      "min-x-amount": uintCV(amounts.minXAmount),
      "min-y-amount": uintCV(amounts.minYAmount),
    });
  });

  if (dryRun) return { txId: null, harvestedX, harvestedY };

  const postConditions = [
    makeStandardFungiblePostCondition(walletAddress, FungibleConditionCode.Equal, totalLiquidityRemoved.toString(), poolAssetInfo),
    makeContractFungiblePostCondition(poolContractAddress, poolContractName, FungibleConditionCode.GreaterEqual, totalMinX.toString(), xAssetInfo),
    makeContractFungiblePostCondition(poolContractAddress, poolContractName, FungibleConditionCode.GreaterEqual, totalMinY.toString(), yAssetInfo),
  ];

  const txOptions = {
    contractAddress: routerAddress,
    contractName: routerName,
    functionName: "withdraw-liquidity-multi",
    functionArgs: [listCV(binWithdrawalPositions)],
    senderKey: privateKey,
    network,
    fee: Math.floor(feeCap * 1_000_000),
    postConditions,
    postConditionMode: PostConditionMode.Deny,
    anchorMode: AnchorMode.Any,
  };

  const transaction = await makeContractCall(txOptions);
  const response = await broadcastTransaction(transaction, network);
  if ("error" in response) throw new Error(`Harvest broadcast failed: ${JSON.stringify(response)}`);
  return { txId: response.txid, harvestedX, harvestedY };
}

async function executeReinvest(
  poolData: PoolData,
  harvestedX: number,
  harvestedY: number,
  walletAddress: string,
  privateKey: string,
  feeCap: number,
  maxSlippage: number,
  dryRun: boolean
): Promise<{ txId: string | null; reinvestedBins: Array<{ binId: number; xAmount: number; yAmount: number }> }> {
  const network = new StacksMainnet();
  const routerAddress = LIQUIDITY_ROUTER_CONTRACT.split(".")[0];
  const routerName = LIQUIDITY_ROUTER_CONTRACT.split(".")[1];
  const poolContractAddress = poolData.pool_contract.split(".")[0];
  const poolContractName = poolData.pool_contract.split(".")[1];
  const xTokenAddress = poolData.x_token.split(".")[0];
  const xTokenName = poolData.x_token.split(".")[1];
  const yTokenAddress = poolData.y_token.split(".")[0];
  const yTokenName = poolData.y_token.split(".")[1];

  const xAssetName = await getTokenAssetName(poolData.x_token);
  const yAssetName = await getTokenAssetName(poolData.y_token);
  const xAssetInfo = createAssetInfo(xTokenAddress, xTokenName, xAssetName);
  const yAssetInfo = createAssetInfo(yTokenAddress, yTokenName, yAssetName);

  const reinvestedBins = [{ binId: poolData.active_bin_id, xAmount: harvestedX, yAmount: harvestedY }];
  if (dryRun) return { txId: null, reinvestedBins };

  // FIX 2: Compute real min-dlp using pool DLP/reserve ratio and slippage tolerance
  const minDlp = computeMinDlp(
    harvestedX,
    harvestedY,
    poolData.total_supply ?? 0,
    poolData.reserve_x ?? 0,
    poolData.reserve_y ?? 0,
    maxSlippage
  );

  const binAddPositions = [
    tupleCV({
      "active-bin-id-offset": intCV(0),
      "x-amount": uintCV(harvestedX),
      "y-amount": uintCV(harvestedY),
      // FIX 2: real min-dlp — expectedDlp * (1 - maxSlippage), never zero
      "min-dlp": uintCV(minDlp),
      "max-x-liquidity-fee": uintCV(Math.ceil(harvestedX * 0.02)),
      "max-y-liquidity-fee": uintCV(Math.ceil(harvestedY * 0.02)),
    }),
  ];

  // FIX 3: FungibleConditionCode.Equal with exact harvest amounts (tighter than GreaterEqual "1")
  const postConditions = [
    makeStandardFungiblePostCondition(
      walletAddress,
      FungibleConditionCode.Equal,
      Math.floor(harvestedX).toString(),
      xAssetInfo
    ),
    makeStandardFungiblePostCondition(
      walletAddress,
      FungibleConditionCode.Equal,
      Math.floor(harvestedY).toString(),
      yAssetInfo
    ),
  ];

  const txOptions = {
    contractAddress: routerAddress,
    contractName: routerName,
    functionName: "add-relative-liquidity-same-multi",
    functionArgs: [
      listCV(binAddPositions),
      contractPrincipalCV(poolContractAddress, poolContractName),
      contractPrincipalCV(xTokenAddress, xTokenName),
      contractPrincipalCV(yTokenAddress, yTokenName),
    ],
    senderKey: privateKey,
    network,
    fee: Math.floor(feeCap * 1_000_000),
    postConditions,
    postConditionMode: PostConditionMode.Deny,
    anchorMode: AnchorMode.Any,
  };

  const transaction = await makeContractCall(txOptions);
  const response = await broadcastTransaction(transaction, network);
  if ("error" in response) throw new Error(`Reinvest broadcast failed: ${JSON.stringify(response)}`);
  return { txId: response.txid, reinvestedBins };
}

// ─── Subcommands ──────────────────────────────────────────────────────────────

async function runDoctor(options: { pool?: string }): Promise<void> {
  const checks: Record<string, string> = { api: "unreachable", wallet: "not-loaded", pool: "not-checked", network: "mainnet" };
  try {
    const res = await fetch(`${STACKS_API}/v2/info`);
    if (res.ok) checks.api = "reachable";
    else throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    out({ status: "error", checks, error: String(err), timestamp: ts() });
    process.exit(1);
  }
  try {
    const { address } = await loadWallet();
    checks.wallet = `loaded (${address.slice(0, 8)}...)`;
  } catch (err) {
    out({ status: "error", checks, error: String(err), timestamp: ts() });
    process.exit(1);
  }
  if (options.pool) {
    const pool = await fetchPoolData(options.pool);
    checks.pool = pool ? `found (activeBin: ${pool.active_bin_id})` : "not-found";
    if (!pool) {
      out({ status: "error", checks, error: `Pool ${options.pool} not found`, timestamp: ts() });
      process.exit(1);
    }
  } else {
    checks.pool = "not-specified";
  }
  out({ status: "ok", checks, timestamp: ts() });
}

async function runStatus(options: { pool: string }): Promise<void> {
  let wallet: { address: string; privateKey: string };
  try {
    wallet = await loadWallet();
  } catch (err) {
    out({ error: String(err), code: "WALLET_ERROR", timestamp: ts() });
    process.exit(1);
  }
  const pool = await fetchPoolData(options.pool);
  if (!pool) {
    out({ error: `Pool ${options.pool} not found`, code: "POOL_NOT_FOUND", timestamp: ts() });
    process.exit(1);
  }
  const userBins = await fetchUserPositionBins(wallet.address, options.pool);
  if (!userBins.length) {
    out({ error: "No position found in this pool", code: "NO_POSITION", timestamp: ts() });
    process.exit(1);
  }
  const { totalFeesX, totalFeesY } = calculateAccumulatedFees(userBins);
  const totalLiquidity = userBins.reduce((sum, b) => sum + b.user_liquidity, 0);
  const feeValue = totalFeesX + totalFeesY;
  const status: CompoundStatus = {
    poolId: options.pool,
    totalLiquidity,
    accumulatedFeesX: totalFeesX,
    accumulatedFeesY: totalFeesY,
    compoundThresholdMet: feeValue >= DEFAULT_MIN_THRESHOLD,
    estimatedCompoundBoostBps: totalLiquidity > 0 ? Math.round((feeValue / totalLiquidity) * 10_000) : 0,
  };
  out({ status: "success", position: status, timestamp: ts() });
}

async function runCompound(options: {
  pool: string;
  maxSlippage?: string;
  feeCap?: string;
  minThreshold?: string;
  interval?: string;
  dryRun?: boolean;
}): Promise<void> {
  if (!options.dryRun && !options.feeCap) {
    out({ error: "--fee-cap <STX> is required for live execution. Use --dry-run first.", code: "FEE_CAP_REQUIRED", timestamp: ts() });
    process.exit(1);
  }
  const maxSlippage = parseFloat(options.maxSlippage ?? String(DEFAULT_MAX_SLIPPAGE));
  const feeCap = options.feeCap ? parseFloat(options.feeCap) : Infinity;
  const minThreshold = parseInt(options.minThreshold ?? String(DEFAULT_MIN_THRESHOLD));
  const pollInterval = options.interval ? Math.max(600_000, parseInt(options.interval) * 1000) : DEFAULT_POLL_INTERVAL_MS;
  const dryRun = options.dryRun ?? false;

  let wallet: { address: string; privateKey: string };
  try {
    wallet = await loadWallet();
  } catch (err) {
    out({ error: String(err), code: "WALLET_ERROR", timestamp: ts() });
    process.exit(1);
  }

  let compoundCount = 0;
  let lastCompoundTime = 0;
  let cycle = 0;

  out({
    status: "started",
    config: {
      poolId: options.pool,
      wallet: wallet.address.slice(0, 8) + "...",
      maxSlippage,
      feeCap: dryRun ? "N/A (dry-run)" : feeCap,
      minThreshold,
      pollIntervalSeconds: pollInterval / 1000,
      maxCompounds: MAX_COMPOUNDS,
      dryRun,
    },
    timestamp: ts(),
  });

  process.on("SIGINT", () => {
    out({ status: "stopped", reason: "SIGINT", cyclesCompleted: cycle, compoundsExecuted: compoundCount, timestamp: ts() });
    process.exit(0);
  });

  while (true) {
    cycle++;
    if (compoundCount >= MAX_COMPOUNDS) {
      out({ status: "stopped", reason: "max-compounds-reached", compoundsExecuted: compoundCount, timestamp: ts() });
      process.exit(0);
    }
    try {
      const pool = await fetchPoolData(options.pool);
      if (!pool) {
        out({ error: `Pool ${options.pool} not found`, code: "POOL_NOT_FOUND", timestamp: ts() });
        break;
      }
      const userBins = await fetchUserPositionBins(wallet.address, options.pool);
      if (!userBins.length) {
        out({ status: "blocked", reason: "no-position", details: { pool: options.pool }, timestamp: ts() });
        await sleep(pollInterval);
        continue;
      }
      const { totalFeesX, totalFeesY } = calculateAccumulatedFees(userBins);
      const feeValue = totalFeesX + totalFeesY;
      if (cycle % 5 === 0) {
        out({ status: "heartbeat", cycle, accumulatedFeesX: totalFeesX, accumulatedFeesY: totalFeesY, compoundsExecuted: compoundCount, timestamp: ts() });
      }
      if (feeValue < minThreshold) {
        out({ status: "blocked", reason: "below-threshold", accumulatedFeesUSTX: feeValue, minThreshold, timestamp: ts() });
        await sleep(pollInterval);
        continue;
      }
      const now = Date.now();
      const cooldownRemaining = COOLDOWN_MS - (now - lastCompoundTime);
      if (lastCompoundTime > 0 && cooldownRemaining > 0) {
        out({ status: "blocked", reason: "cooldown-active", cooldownRemainingSeconds: Math.ceil(cooldownRemaining / 1000), timestamp: ts() });
        await sleep(pollInterval);
        continue;
      }
      const { txId: harvestTxId, harvestedX, harvestedY } = await executeHarvest(pool, userBins, wallet.address, wallet.privateKey, feeCap, maxSlippage * 100, dryRun);
      if (!dryRun && harvestTxId) {
        out({ status: "harvesting", txId: harvestTxId, timestamp: ts() });
        const confirmed = await pollTxConfirmation(harvestTxId);
        if (!confirmed) {
          out({ error: "Harvest transaction did not confirm within timeout — reinvest cancelled", code: "HARVEST_TIMEOUT", txId: harvestTxId, timestamp: ts() });
          await sleep(pollInterval);
          continue;
        }
      }
      const { txId: reinvestTxId, reinvestedBins } = await executeReinvest(
        pool, harvestedX, harvestedY,
        wallet.address, wallet.privateKey,
        feeCap, maxSlippage, dryRun
      );
      compoundCount++;
      lastCompoundTime = Date.now();
      out({
        status: dryRun ? "dry-run" : "compounded",
        action: "harvest-and-reinvest",
        harvestedFeesX: harvestedX,
        harvestedFeesY: harvestedY,
        reinvestedBins,
        harvestTxId: harvestTxId ?? null,
        reinvestTxId: reinvestTxId ?? null,
        compoundCount,
        timestamp: ts(),
      });
    } catch (err) {
      out({ error: err instanceof Error ? err.message : String(err), code: "COMPOUND_ERROR", cycle, timestamp: ts() });
      await sleep(Math.min(pollInterval * 2, 120_000));
      continue;
    }
    await sleep(pollInterval);
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();
program.name("hodlmm-compounder").description("Autonomously harvest and reinvest Bitflow HODLMM trading fees back into the pool").version("1.0.0");

program.command("doctor").description("Validate API connectivity, wallet, and pool access").option("--pool <id>", "HODLMM pool ID to validate").action(async (options) => { await runDoctor(options); });

program.command("status").description("Get current position fees and compound readiness").requiredOption("--pool <id>", "HODLMM pool ID to check").action(async (options) => { await runStatus(options); });

program.command("run").description("Start autonomous compound loop — harvest fees and reinvest on schedule")
  .requiredOption("--pool <id>", "HODLMM pool ID to compound")
  .option("--max-slippage <decimal>", "Max slippage for reinvest (default: 0.01)", "0.01")
  .option("--fee-cap <STX>", "Max STX fee per transaction (required for live)")
  .option("--min-threshold <uSTX>", "Min fee value to trigger compound (default: 10000)", "10000")
  .option("--interval <seconds>", "Poll interval in seconds (min 600, default 3600)", "3600")
  .option("--dry-run", "Simulate compounding without broadcasting transactions")
  .action(async (options) => { await runCompound(options); });

program.parseAsync(process.argv).catch((err) => {
  out({ error: err instanceof Error ? err.message : String(err), code: "PARSE_ERROR", timestamp: Math.floor(Date.now() / 1000) });
  process.exit(1);
});
