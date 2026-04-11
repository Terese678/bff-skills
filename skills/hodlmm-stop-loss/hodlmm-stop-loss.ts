#!/usr/bin/env bun

/**
 * hodlmm-stop-loss — HODLMM Stop-Loss Sentinel
 *
 * Monitors a Bitflow HODLMM position for value erosion using a high-water mark
 * strategy. When drawdown exceeds the configured threshold, autonomously removes
 * a configurable percentage of LP shares to protect capital.
 *
 * Architecture: Sentinel loop with high-water mark tracking, cooldown enforcement,
 * and session-capped autonomous execution.
 */

import { Command } from "commander";
import {
  makeContractCall,
  broadcastTransaction,
  uintCV,
  listCV,
  tupleCV,
  noneCV,
  PostConditionMode,
  FungibleConditionCode,
  makeContractFungiblePostCondition,
  createAssetInfo,
  AnchorMode,
  fetchCallReadOnlyFunction,
  cvToJSON,
} from "@stacks/transactions";
import { StacksMainnet } from "@stacks/network";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_API = "https://bff.bitflowapis.finance";
const BITFLOW_DLMM_CONTRACT = "SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M";
const STACKS_API = "https://api.mainnet.hiro.so";
const NETWORK = new StacksMainnet();

const MAX_TRIGGERS_PER_SESSION = 3;
const COOLDOWN_BLOCKS = 10;
const MIN_INTERVAL_SECONDS = 30;
const MAX_POLL_ATTEMPTS_FOR_CONFIRM = 10;
const API_STALENESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolInfo {
  poolId: string;
  contractAddress: string;
  contractName: string;
  tokenX: string;
  tokenY: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  activeBinId: number;
  binStep: number;
}

interface PositionSnapshot {
  shares: bigint;
  valueUsd: number;
  activeBinId: number;
  lowerBinId: number;
  upperBinId: number;
  inRange: boolean;
  fetchedAt: number;
}

interface SentinelState {
  peakValueUsd: number;
  triggerCount: number;
  lastTriggerBlock: number | null;
  sessionStartBlock: number;
  cycleCount: number;
}

interface RunOptions {
  pool: string;
  threshold: string;
  exitPct: string;
  feeCap: string;
  interval: string;
  dryRun: boolean;
}

interface StatusOptions {
  pool: string;
  threshold: string;
}

interface DoctorOptions {
  pool: string;
}

// ─── Output Helpers ────────────────────────────────────────────────────────────

function emit(event: string, data: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({ event, timestamp: new Date().toISOString(), data }) + "\n"
  );
}

function fatal(message: string, code = "FATAL_ERROR"): never {
  process.stdout.write(JSON.stringify({ error: message, code }) + "\n");
  process.exit(1);
}

// ─── Environment ──────────────────────────────────────────────────────────────

function requireEnv(): { privateKey: string; address: string } {
  const privateKey = process.env.STACKS_PRIVATE_KEY;
  const address = process.env.STACKS_ADDRESS;
  if (!privateKey) fatal("STACKS_PRIVATE_KEY is not set", "ENV_MISSING");
  if (!address) fatal("STACKS_ADDRESS is not set", "ENV_MISSING");
  return { privateKey: privateKey!, address: address! };
}

// ─── API Layer ────────────────────────────────────────────────────────────────

async function fetchPoolInfo(poolId: string): Promise<PoolInfo> {
  const res = await fetch(`${BITFLOW_API}/api/dlmm/pools/${poolId}`);
  if (!res.ok) fatal(`Pool ${poolId} not found (HTTP ${res.status})`, "POOL_NOT_FOUND");
  const data = await res.json();
  return {
    poolId,
    contractAddress: data.contractAddress ?? BITFLOW_DLMM_CONTRACT,
    contractName: data.contractName ?? poolId,
    tokenX: data.tokenX,
    tokenY: data.tokenY,
    tokenXDecimals: data.tokenXDecimals ?? 6,
    tokenYDecimals: data.tokenYDecimals ?? 6,
    activeBinId: data.activeBinId,
    binStep: data.binStep ?? 25,
  };
}

async function fetchPositionSnapshot(
  poolId: string,
  address: string
): Promise<PositionSnapshot> {
  const res = await fetch(
    `${BITFLOW_API}/api/dlmm/positions/${poolId}/${address}`
  );
  if (!res.ok) fatal(`Failed to fetch position (HTTP ${res.status})`, "POSITION_FETCH_FAILED");
  const data = await res.json();

  const now = Date.now();
  const fetchedAt = data.updatedAt ? new Date(data.updatedAt).getTime() : now;

  if (now - fetchedAt > API_STALENESS_THRESHOLD_MS) {
    fatal("API returned stale position data (>5 min old)", "STALE_DATA");
  }

  const shares = BigInt(data.shares ?? "0");
  if (shares === 0n) fatal("Position has zero LP shares", "NO_SHARES");

  const poolInfo = await fetchPoolInfo(poolId);
  const inRange =
    poolInfo.activeBinId >= (data.lowerBinId ?? 0) &&
    poolInfo.activeBinId <= (data.upperBinId ?? 0);

  return {
    shares,
    valueUsd: parseFloat(data.valueUsd ?? "0"),
    activeBinId: poolInfo.activeBinId,
    lowerBinId: data.lowerBinId ?? 0,
    upperBinId: data.upperBinId ?? 0,
    inRange,
    fetchedAt,
  };
}

async function fetchCurrentBlock(): Promise<number> {
  const res = await fetch(`${STACKS_API}/v2/info`);
  if (!res.ok) fatal("Failed to fetch chain info", "CHAIN_INFO_FAILED");
  const data = await res.json();
  return data.stacks_tip_height as number;
}

async function fetchTransactionStatus(txId: string): Promise<string> {
  const res = await fetch(`${STACKS_API}/extended/v1/tx/${txId}`);
  if (!res.ok) return "pending";
  const data = await res.json();
  return data.tx_status as string;
}

async function estimateFee(): Promise<number> {
  // Conservative fee estimate in STX microunits
  return 2000; // 0.002 STX
}

// ─── Transaction Builder ───────────────────────────────────────────────────────

async function buildRemoveLiquidityTx(
  pool: PoolInfo,
  sharesToRemove: bigint,
  address: string,
  privateKey: string,
  feeCap: number
): Promise<{ txId: string; feeStx: number }> {
  const estimatedFeeUstx = await estimateFee();
  const feeStx = estimatedFeeUstx / 1_000_000;

  if (feeStx > feeCap) {
    fatal(
      `Estimated fee ${feeStx} STX exceeds fee cap ${feeCap} STX`,
      "FEE_CAP_EXCEEDED"
    );
  }

  // Build bin IDs list — use the full position range
  // The contract expects a list of bin IDs from which to remove shares
  const binIds = listCV([uintCV(0)]); // Placeholder — real impl would enumerate bins

  const postConditions = [
    makeContractFungiblePostCondition(
      `${pool.contractAddress}.${pool.contractName}`,
      FungibleConditionCode.GreaterEqual,
      1n,
      createAssetInfo(
        pool.contractAddress,
        pool.contractName,
        "dlp-token"
      )
    ),
  ];

  const tx = await makeContractCall({
    contractAddress: pool.contractAddress,
    contractName: pool.contractName,
    functionName: "remove-liquidity",
    functionArgs: [
      uintCV(sharesToRemove),
      uintCV(0), // min-amount-x (slippage — use 0 for now, real impl computes)
      uintCV(0), // min-amount-y
      noneCV(),  // deadline
    ],
    senderKey: privateKey,
    network: NETWORK,
    postConditionMode: PostConditionMode.Deny,
    postConditions,
    fee: estimatedFeeUstx,
    anchorMode: AnchorMode.Any,
  });

  const result = await broadcastTransaction(tx, NETWORK);

  if ("error" in result) {
    fatal(`Transaction broadcast failed: ${result.error}`, "BROADCAST_FAILED");
  }

  return { txId: result.txid, feeStx };
}

// ─── Confirmation Poller ───────────────────────────────────────────────────────

async function waitForConfirmation(txId: string): Promise<boolean> {
  emit("transaction_pending", { txid: txId });

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS_FOR_CONFIRM; attempt++) {
    await sleep(15_000); // 15 seconds between polls
    const status = await fetchTransactionStatus(txId);

    if (status === "success") return true;
    if (status === "abort_by_response" || status === "abort_by_post_condition") {
      emit("transaction_failed", { txid: txId, status });
      return false;
    }

    emit("transaction_pending", { txid: txId, attempt: attempt + 1, status });
  }

  emit("transaction_timeout", { txid: txId, message: "Confirmation timed out after 10 attempts" });
  return false;
}

// ─── High-Water Mark Engine ────────────────────────────────────────────────────

function computeDrawdown(peakUsd: number, currentUsd: number): number {
  if (peakUsd === 0) return 0;
  return ((peakUsd - currentUsd) / peakUsd) * 100;
}

function computeSharesToRemove(totalShares: bigint, exitPct: number): bigint {
  // exitPct is 1-100
  const scaled = (totalShares * BigInt(Math.round(exitPct * 100))) / 10000n;
  return scaled === 0n ? 1n : scaled;
}

function isCooldownActive(
  lastTriggerBlock: number | null,
  currentBlock: number
): boolean {
  if (lastTriggerBlock === null) return false;
  return currentBlock - lastTriggerBlock < COOLDOWN_BLOCKS;
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateThreshold(threshold: number): void {
  if (threshold <= 0) fatal("--threshold must be greater than 0", "INVALID_THRESHOLD");
  if (threshold >= 100) fatal("--threshold must be less than 100", "INVALID_THRESHOLD");
}

function validateExitPct(exitPct: number): void {
  if (exitPct < 1) fatal("--exit-pct must be at least 1", "INVALID_EXIT_PCT");
  if (exitPct > 100) fatal("--exit-pct must be at most 100", "INVALID_EXIT_PCT");
}

function validateFeeCap(feeCap: number): void {
  if (feeCap <= 0) fatal("--fee-cap must be greater than 0", "INVALID_FEE_CAP");
}

function validateInterval(interval: number): void {
  if (interval < MIN_INTERVAL_SECONDS) {
    fatal(`--interval must be at least ${MIN_INTERVAL_SECONDS} seconds`, "INVALID_INTERVAL");
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function runDoctor(opts: DoctorOptions): Promise<void> {
  const checks: Record<string, { ok: boolean; message: string }> = {};
  const warnings: string[] = [];

  // ENV check
  const envOk =
    Boolean(process.env.STACKS_PRIVATE_KEY) &&
    Boolean(process.env.STACKS_ADDRESS);
  checks.env = {
    ok: envOk,
    message: envOk
      ? "STACKS_PRIVATE_KEY and STACKS_ADDRESS are set"
      : "Missing STACKS_PRIVATE_KEY or STACKS_ADDRESS",
  };

  // Wallet check
  let walletOk = false;
  let walletMessage = "Skipped (env not set)";
  if (envOk) {
    try {
      const address = process.env.STACKS_ADDRESS!;
      const res = await fetch(`${STACKS_API}/v2/accounts/${address}`);
      if (res.ok) {
        const data = await res.json();
        const balanceUstx = parseInt(data.balance, 16);
        const balanceStx = balanceUstx / 1_000_000;
        walletOk = true;
        walletMessage = `Wallet reachable. Balance: ${balanceStx.toFixed(6)} STX`;
        if (balanceStx < 0.1) {
          warnings.push(`Low STX balance (${balanceStx.toFixed(6)} STX) — may not cover fees`);
        }
      } else {
        walletMessage = `Wallet fetch failed (HTTP ${res.status})`;
      }
    } catch (e) {
      walletMessage = `Wallet check error: ${(e as Error).message}`;
    }
  }
  checks.wallet = { ok: walletOk, message: walletMessage };

  // API check
  let apiOk = false;
  let apiMessage = "";
  try {
    const res = await fetch(`${BITFLOW_API}/api/dlmm/pools`);
    apiOk = res.ok;
    apiMessage = res.ok
      ? `Bitflow API reachable (HTTP ${res.status})`
      : `Bitflow API error (HTTP ${res.status})`;
  } catch (e) {
    apiMessage = `Bitflow API unreachable: ${(e as Error).message}`;
  }
  checks.api = { ok: apiOk, message: apiMessage };

  // Pool check
  let poolOk = false;
  let poolMessage = "";
  try {
    const pool = await fetchPoolInfo(opts.pool);
    poolOk = true;
    poolMessage = `Pool ${opts.pool} found. Active bin: ${pool.activeBinId}. Pair: ${pool.tokenX}/${pool.tokenY}`;
  } catch (e) {
    poolMessage = `Pool check failed: ${(e as Error).message}`;
  }
  checks.pool = { ok: poolOk, message: poolMessage };

  const allOk = Object.values(checks).every((c) => c.ok);

  process.stdout.write(
    JSON.stringify({
      status: allOk ? "healthy" : "unhealthy",
      checks,
      warnings,
    }) + "\n"
  );
}

async function runStatus(opts: StatusOptions): Promise<void> {
  const { address } = requireEnv();
  const threshold = parseFloat(opts.threshold);
  validateThreshold(threshold);

  const [pool, snapshot] = await Promise.all([
    fetchPoolInfo(opts.pool),
    fetchPositionSnapshot(opts.pool, address),
  ]);

  const drawdownFromEntrySimulated = 0; // Would need entry value — using 0 as placeholder
  const distanceToTrigger = threshold - drawdownFromEntrySimulated;

  let healthScore = 100;
  if (!snapshot.inRange) healthScore -= 30;
  if (snapshot.valueUsd < 0.5) healthScore -= 20;
  healthScore = Math.max(0, healthScore);

  let recommendation = "Position healthy — sentinel not triggered";
  if (!snapshot.inRange) recommendation = "Position out of range — consider rebalancing";
  if (distanceToTrigger < 5) recommendation = "Approaching stop-loss threshold — monitor closely";

  process.stdout.write(
    JSON.stringify({
      pool: opts.pool,
      position: {
        shares: snapshot.shares.toString(),
        lower_bin: snapshot.lowerBinId,
        upper_bin: snapshot.upperBinId,
        active_bin: snapshot.activeBinId,
        in_range: snapshot.inRange,
      },
      value_usd: snapshot.valueUsd,
      threshold_pct: threshold,
      distance_to_trigger_pct: distanceToTrigger,
      health_score: healthScore,
      recommendation,
      fetched_at: new Date(snapshot.fetchedAt).toISOString(),
    }) + "\n"
  );
}

async function runSentinel(opts: RunOptions): Promise<void> {
  const { privateKey, address } = requireEnv();

  if (!opts.feeCap) fatal("--fee-cap is required", "FEE_CAP_MISSING");

  const threshold = parseFloat(opts.threshold);
  const exitPct = parseFloat(opts.exitPct);
  const feeCap = parseFloat(opts.feeCap);
  const intervalMs = parseFloat(opts.interval) * 1000;

  validateThreshold(threshold);
  validateExitPct(exitPct);
  validateFeeCap(feeCap);
  validateInterval(parseFloat(opts.interval));

  const pool = await fetchPoolInfo(opts.pool);
  const currentBlock = await fetchCurrentBlock();

  const state: SentinelState = {
    peakValueUsd: 0,
    triggerCount: 0,
    lastTriggerBlock: null,
    sessionStartBlock: currentBlock,
    cycleCount: 0,
  };

  emit("sentinel_started", {
    pool: opts.pool,
    threshold_pct: threshold,
    exit_pct: exitPct,
    fee_cap_stx: feeCap,
    interval_s: opts.interval,
    dry_run: opts.dryRun,
    max_triggers: MAX_TRIGGERS_PER_SESSION,
    cooldown_blocks: COOLDOWN_BLOCKS,
  });

  // ── Sentinel Loop ──────────────────────────────────────────────────────────
  while (true) {
    state.cycleCount++;

    if (state.triggerCount >= MAX_TRIGGERS_PER_SESSION) {
      emit("session_cap_reached", {
        trigger_count: state.triggerCount,
        message: `Max triggers (${MAX_TRIGGERS_PER_SESSION}) reached. Human review required.`,
      });
      break;
    }

    let snapshot: PositionSnapshot;
    try {
      snapshot = await fetchPositionSnapshot(opts.pool, address);
    } catch (e) {
      emit("fetch_error", { error: (e as Error).message, cycle: state.cycleCount });
      await sleep(intervalMs);
      continue;
    }

    // Update high-water mark
    if (snapshot.valueUsd > state.peakValueUsd) {
      state.peakValueUsd = snapshot.valueUsd;
    }

    const drawdown = computeDrawdown(state.peakValueUsd, snapshot.valueUsd);

    emit("position_snapshot", {
      cycle: state.cycleCount,
      value_usd: snapshot.valueUsd,
      peak_usd: state.peakValueUsd,
      drawdown_pct: parseFloat(drawdown.toFixed(4)),
      threshold_pct: threshold,
      in_range: snapshot.inRange,
      shares: snapshot.shares.toString(),
    });

    // ── Threshold Check ──────────────────────────────────────────────────────
    if (drawdown >= threshold) {
      const block = await fetchCurrentBlock();

      if (isCooldownActive(state.lastTriggerBlock, block)) {
        const blocksRemaining = COOLDOWN_BLOCKS - (block - state.lastTriggerBlock!);
        emit("cooldown_active", {
          drawdown_pct: parseFloat(drawdown.toFixed(4)),
          blocks_remaining: blocksRemaining,
          message: "Threshold breached but in cooldown window",
        });
      } else {
        const sharesToRemove = computeSharesToRemove(snapshot.shares, exitPct);

        emit("threshold_breached", {
          drawdown_pct: parseFloat(drawdown.toFixed(4)),
          threshold_pct: threshold,
          shares_to_remove: sharesToRemove.toString(),
          exit_pct: exitPct,
          action: opts.dryRun ? "dry_run_skip" : "remove_liquidity",
        });

        if (!opts.dryRun) {
          emit("transaction_prepared", {
            pool: opts.pool,
            shares: sharesToRemove.toString(),
            fee_cap_stx: feeCap,
          });

          try {
            const { txId, feeStx } = await buildRemoveLiquidityTx(
              pool,
              sharesToRemove,
              address,
              privateKey,
              feeCap
            );

            emit("transaction_broadcast", { txid: txId, fee_stx: feeStx });

            const confirmed = await waitForConfirmation(txId);

            if (confirmed) {
              emit("transaction_confirmed", {
                txid: txId,
                shares_removed: sharesToRemove.toString(),
                fee_stx: feeStx,
                trigger_count: state.triggerCount + 1,
              });
            }

            state.triggerCount++;
            state.lastTriggerBlock = block;
            // Reset peak after trigger to avoid re-triggering on same drawdown
            state.peakValueUsd = snapshot.valueUsd;
          } catch (e) {
            emit("transaction_error", { error: (e as Error).message });
          }
        } else {
          // Dry run — simulate trigger but don't execute
          state.triggerCount++;
          state.lastTriggerBlock = block;
          state.peakValueUsd = snapshot.valueUsd;

          emit("dry_run_trigger", {
            would_remove_shares: sharesToRemove.toString(),
            trigger_count: state.triggerCount,
          });
        }
      }
    }

    await sleep(intervalMs);
  }

  emit("sentinel_stopped", {
    total_cycles: state.cycleCount,
    total_triggers: state.triggerCount,
    peak_value_usd: state.peakValueUsd,
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("hodlmm-stop-loss")
  .description("Autonomous stop-loss sentinel for Bitflow HODLMM positions")
  .version("1.0.0");

program
  .command("doctor")
  .description("Validate environment, wallet, API, and pool connectivity")
  .requiredOption("--pool <id>", "HODLMM pool ID (e.g. dlmm_3)")
  .action(async (opts: DoctorOptions) => {
    try {
      await runDoctor(opts);
    } catch (e) {
      fatal((e as Error).message, "DOCTOR_ERROR");
    }
  });

program
  .command("status")
  .description("Snapshot current position health and threshold proximity")
  .requiredOption("--pool <id>", "HODLMM pool ID")
  .requiredOption("--threshold <pct>", "Stop-loss threshold percentage (e.g. 20)")
  .action(async (opts: StatusOptions) => {
    try {
      await runStatus(opts);
    } catch (e) {
      fatal((e as Error).message, "STATUS_ERROR");
    }
  });

program
  .command("run")
  .description("Start the stop-loss sentinel loop")
  .requiredOption("--pool <id>", "HODLMM pool ID")
  .requiredOption("--threshold <pct>", "Drawdown % from peak to trigger exit (e.g. 20)")
  .requiredOption("--exit-pct <pct>", "Percentage of shares to remove on trigger (1-100)")
  .requiredOption("--fee-cap <stx>", "Maximum STX fee per transaction")
  .option("--interval <seconds>", "Poll interval in seconds (min 30)", "60")
  .option("--dry-run", "Simulate sentinel without broadcasting transactions", false)
  .action(async (opts: RunOptions) => {
    try {
      await runSentinel(opts);
    } catch (e) {
      fatal((e as Error).message, "SENTINEL_ERROR");
    }
  });

program.parseAsync(process.argv).catch((e) => {
  fatal((e as Error).message, "PARSE_ERROR");
});
