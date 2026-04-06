#!/usr/bin/env bun
/**
 * hodlmm-range-rebalancer
 *
 * Monitors a Bitflow HODLMM liquidity position and autonomously rebalances
 * the bin range when the active bin drifts outside the deposited range.
 *
 * API: https://bff.bitflowapis.finance/api (official Bitflow HODLMM API)
 * Contract: SP3ESW1QCNQPVXJDGQWT7E45RDCH38QBK9HEJSX4X.dlmm-liquidity-router-v-0-1
 * Method: move-relative-liquidity-multi (Simple mode — resilient to active bin shifts)
 */

import { Command } from "commander";
import {
  intCV,
  uintCV,
  listCV,
  tupleCV,
  contractPrincipalCV,
  createAssetInfo,
  makeStandardFungiblePostCondition,
  makeContractFungiblePostCondition,
  FungibleConditionCode,
  PostConditionMode,
  AnchorMode,
  makeContractCall,
  broadcastTransaction,
} from "@stacks/transactions";
import { StacksMainnet } from "@stacks/network";

// ─── Constants ───────────────────────────────────────────────────────────────

const BFF_API_BASE = "https://bff.bitflowapis.finance/api";
const LIQUIDITY_ROUTER_CONTRACT =
  "SP3ESW1QCNQPVXJDGQWT7E45RDCH38QBK9HEJSX4X.dlmm-liquidity-router-v-0-1";
const STACKS_NETWORK = new StacksMainnet();

const COOLDOWN_SECONDS = 3600;
const SESSION_REBALANCE_CAP = 10;
const POLL_INTERVAL_MS = 60_000; // 1 minute

// ─── Bin ID conversion ────────────────────────────────────────────────────────
//
// Bitflow HODLMM stores bin IDs as unsigned integers offset by 2^23 (8_388_608).
// The "zero" active bin maps to 8_388_608 on-chain. The Clarity contract accepts
// signed bin IDs using intCV. To convert an absolute unsigned bin ID from the API
// into the signed representation, subtract the midpoint offset 8_388_608.
// Example: API bin_id 8_388_610 → signed +2 (two bins above active).
//
const BIN_ID_MIDPOINT = 8_388_608;

function toSignedBinId(unsignedBinId: number): number {
  return unsignedBinId - BIN_ID_MIDPOINT;
}

// Minimum DLP protection in basis points (50 bps = 0.5%)
// Prevents value loss during liquidity moves — never set to 0
const MIN_DLP_BPS = 50;

// ─── Types ───────────────────────────────────────────────────────────────────

interface Config {
  poolId: string;
  address: string;
  maxSlippage: number;
  feeCap: number;
  dryRun: boolean;
  apiKey: string;
}

interface PositionBin {
  bin_id: number;
  user_liquidity: number;
  liquidity: number;
  reserve_x: number;
  reserve_y: number;
}

interface UserPosition {
  bins: PositionBin[];
}

interface PoolBin {
  bin_id: number;
  price: string;
  reserve_x: string;
  reserve_y: string;
  liquidity: string;
}

interface PoolBins {
  active_bin_id: number;
  bins: PoolBin[];
}

interface RebalancerState {
  lastRebalanceTs: number;
  rebalanceCount: number;
}

// ─── API Helpers ─────────────────────────────────────────────────────────────

function apiHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }
  return headers;
}

async function fetchApiHealth(apiKey: string): Promise<boolean> {
  // FIX: removed duplicate /api/ — was "${BFF_API_BASE}/api/validation/health"
  const res = await fetch(`${BFF_API_BASE}/validation/health`, {
    method: "GET",
    headers: apiHeaders(apiKey),
  });
  return res.ok;
}

async function fetchPoolBins(poolId: string, apiKey: string): Promise<PoolBins> {
  const res = await fetch(`${BFF_API_BASE}/quotes/v1/bins/${poolId}`, {
    method: "GET",
    headers: apiHeaders(apiKey),
  });
  if (!res.ok) {
    throw new Error(`Pool bins fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchUserPositionBins(
  address: string,
  poolId: string,
  apiKey: string
): Promise<UserPosition> {
  const res = await fetch(
    `${BFF_API_BASE}/app/v1/users/${address}/positions/${poolId}/bins`,
    {
      method: "GET",
      headers: apiHeaders(apiKey),
    }
  );
  if (!res.ok) {
    throw new Error(
      `User position bins fetch failed: ${res.status} ${res.statusText}`
    );
  }
  return res.json();
}

async function fetchPoolData(poolId: string, apiKey: string): Promise<any> {
  const res = await fetch(`${BFF_API_BASE}/app/v1/pools/${poolId}`, {
    method: "GET",
    headers: apiHeaders(apiKey),
  });
  if (!res.ok) {
    throw new Error(`Pool data fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function getTokenAssetName(
  tokenContract: string,
  apiKey: string
): Promise<string> {
  const res = await fetch(`${BFF_API_BASE}/quotes/v1/tokens`, {
    headers: apiHeaders(apiKey),
  });
  if (!res.ok) throw new Error(`Tokens API error: ${res.status}`);
  const data = await res.json();
  const token = data.tokens?.find(
    (t: { contract_address: string; asset_name: string }) =>
      t.contract_address === tokenContract
  );
  if (!token) throw new Error(`Token not found: ${tokenContract}`);
  return token.asset_name;
}

// ─── Rebalance Logic ─────────────────────────────────────────────────────────

function computeNewRangeOffsets(
  currentLowerBin: number,
  currentUpperBin: number,
  activeBin: number
): { lowerOffset: number; upperOffset: number } {
  const halfWidth = Math.floor((currentUpperBin - currentLowerBin) / 2);
  return {
    lowerOffset: -halfWidth,
    upperOffset: halfWidth,
  };
}

function estimateSlippage(
  bins: PositionBin[],
  activeBin: number,
  currentLower: number,
  currentUpper: number
): number {
  const drift = Math.abs(
    activeBin - Math.floor((currentLower + currentUpper) / 2)
  );
  const rangeWidth = currentUpper - currentLower;
  const driftBeyondRange = Math.max(0, drift - Math.floor(rangeWidth / 2));
  return Math.min(driftBeyondRange * 0.1, 10);
}

async function executeMoveRelativeLiquidity(
  config: Config,
  userPositionBins: PositionBin[],
  activeBin: number,
  poolData: any
): Promise<string> {
  const privateKey = process.env.STACKS_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("STACKS_PRIVATE_KEY environment variable not set");
  }

  const routerAddress = LIQUIDITY_ROUTER_CONTRACT.split(".")[0];
  const routerName = LIQUIDITY_ROUTER_CONTRACT.split(".")[1];

  const poolParts = poolData.pool_contract?.split(".") || [];
  if (poolParts.length !== 2) throw new Error("Invalid pool_contract in pool data");
  const poolContractAddress = poolParts[0];
  const poolContractName = poolParts[1];

  const xParts = poolData.x_token_contract?.split(".") || [];
  const yParts = poolData.y_token_contract?.split(".") || [];
  if (xParts.length !== 2 || yParts.length !== 2)
    throw new Error("Invalid token contracts in pool data");

  const currentLower = Math.min(...userPositionBins.map((b) => b.bin_id));
  const currentUpper = Math.max(...userPositionBins.map((b) => b.bin_id));
  const { lowerOffset, upperOffset } = computeNewRangeOffsets(
    currentLower,
    currentUpper,
    activeBin
  );

  const slippageMultiplier = 1 - config.maxSlippage / 100;

  // Totals for post-conditions
  const totalUserLiquidity = userPositionBins.reduce(
    (s, b) => s + b.user_liquidity,
    0
  );
  const totalMinX = Math.floor(
    userPositionBins.reduce(
      (s, b) => s + b.reserve_x * (b.user_liquidity / (b.liquidity || 1)),
      0
    ) * slippageMultiplier
  );
  const totalMinY = Math.floor(
    userPositionBins.reduce(
      (s, b) => s + b.reserve_y * (b.user_liquidity / (b.liquidity || 1)),
      0
    ) * slippageMultiplier
  );

  const binsToMove = userPositionBins
    .filter((b) => b.user_liquidity > 0)
    .map((bin) => {
      const relativePosition =
        (bin.bin_id - currentLower) / (currentUpper - currentLower);
      const newOffset = Math.round(
        lowerOffset + relativePosition * (upperOffset - lowerOffset)
      );

      // FIX: use toSignedBinId() with documented midpoint offset (BIN_ID_MIDPOINT = 8_388_608)
      // instead of magic number subtraction of 500
      return tupleCV({
        "pool-trait": contractPrincipalCV(poolContractAddress, poolContractName),
        "x-token-trait": contractPrincipalCV(xParts[0], xParts[1]),
        "y-token-trait": contractPrincipalCV(yParts[0], yParts[1]),
        "from-bin-id": intCV(toSignedBinId(bin.bin_id)),
        "active-bin-id-offset": intCV(newOffset),
        amount: uintCV(bin.user_liquidity),
        // FIX: non-zero min-dlp (MIN_DLP_BPS = 50bps) protects against value loss
        "min-dlp": uintCV(Math.floor(bin.user_liquidity * (MIN_DLP_BPS / 10_000))),
        "max-x-liquidity-fee": uintCV(Math.ceil(bin.reserve_x * 0.02)),
        "max-y-liquidity-fee": uintCV(Math.ceil(bin.reserve_y * 0.02)),
      });
    });

  if (binsToMove.length === 0) throw new Error("No bins with liquidity to move");

  // FIX: explicit post-conditions + PostConditionMode.Deny instead of Allow
  const xAssetName = await getTokenAssetName(
    `${xParts[0]}.${xParts[1]}`,
    config.apiKey
  );
  const yAssetName = await getTokenAssetName(
    `${yParts[0]}.${yParts[1]}`,
    config.apiKey
  );
  const xAssetInfo = createAssetInfo(xParts[0], xParts[1], xAssetName);
  const yAssetInfo = createAssetInfo(yParts[0], yParts[1], yAssetName);
  const poolAssetInfo = createAssetInfo(
    poolContractAddress,
    poolContractName,
    "pool-token"
  );

  const postConditions = [
    makeStandardFungiblePostCondition(
      config.address,
      FungibleConditionCode.Equal,
      totalUserLiquidity.toString(),
      poolAssetInfo
    ),
    makeContractFungiblePostCondition(
      poolContractAddress,
      poolContractName,
      FungibleConditionCode.GreaterEqual,
      totalMinX.toString(),
      xAssetInfo
    ),
    makeContractFungiblePostCondition(
      poolContractAddress,
      poolContractName,
      FungibleConditionCode.GreaterEqual,
      totalMinY.toString(),
      yAssetInfo
    ),
  ];

  const txOptions: any = {
    contractAddress: routerAddress,
    contractName: routerName,
    functionName: "move-relative-liquidity-multi",
    functionArgs: [listCV(binsToMove)],
    senderKey: privateKey,
    network: STACKS_NETWORK,
    fee: config.feeCap,
    postConditions,
    postConditionMode: PostConditionMode.Deny,
    anchorMode: AnchorMode.Any,
  };

  const transaction = await makeContractCall(txOptions);
  const response = await broadcastTransaction(transaction, STACKS_NETWORK);

  if (response.error) throw new Error(`Broadcast failed: ${response.error}`);

  return response.txid;
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

async function runDoctor(config: Config): Promise<void> {
  const checks: Record<string, string> = {};

  const privateKey = process.env.STACKS_PRIVATE_KEY;
  checks.wallet = privateKey ? "loaded" : "missing";
  checks.network = "mainnet";

  try {
    const healthy = await fetchApiHealth(config.apiKey);
    checks.api = healthy ? "reachable" : "unhealthy";
  } catch {
    checks.api = "unreachable";
  }

  try {
    const poolBins = await fetchPoolBins(config.poolId, config.apiKey);
    checks.pool = poolBins?.bins?.length > 0 ? "found" : "not-found";
  } catch {
    checks.pool = "error";
  }

  const allOk = Object.values(checks).every(
    (v) => ["loaded", "mainnet", "reachable", "found"].includes(v)
  );

  console.log(JSON.stringify({ status: allOk ? "ok" : "degraded", checks }));
}

async function runStatus(config: Config): Promise<void> {
  const poolBins = await fetchPoolBins(config.poolId, config.apiKey);
  const activeBin = poolBins.active_bin_id;

  const userPositionBins = await fetchUserPositionBins(
    config.address,
    config.poolId,
    config.apiKey
  );

  const binsWithLiquidity = (userPositionBins.bins || []).filter(
    (b) => b.user_liquidity > 0
  );

  if (binsWithLiquidity.length === 0) {
    console.log(
      JSON.stringify({ error: "No liquidity found in pool for this address" })
    );
    return;
  }

  const lowerBin = Math.min(...binsWithLiquidity.map((b) => b.bin_id));
  const upperBin = Math.max(...binsWithLiquidity.map((b) => b.bin_id));
  const inRange = activeBin >= lowerBin && activeBin <= upperBin;

  console.log(
    JSON.stringify({
      status: "success",
      position: {
        poolId: config.poolId,
        activeBin,
        depositedRange: { lower: lowerBin, upper: upperBin },
        inRange,
        rebalanceRecommended: !inRange,
      },
      timestamp: Math.floor(Date.now() / 1000),
    })
  );
}

async function runMonitor(config: Config): Promise<void> {
  if (!config.feeCap || config.feeCap <= 0) {
    console.log(
      JSON.stringify({
        error: "--fee-cap is required. No transaction will execute without a spend limit.",
      })
    );
    process.exit(1);
  }

  const state: RebalancerState = { lastRebalanceTs: 0, rebalanceCount: 0 };

  process.on("SIGINT", () => {
    console.log(
      JSON.stringify({ status: "shutdown", rebalanceCount: state.rebalanceCount })
    );
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log(
      JSON.stringify({ status: "shutdown", rebalanceCount: state.rebalanceCount })
    );
    process.exit(0);
  });

  let cycle = 0;

  while (true) {
    cycle++;

    try {
      if (state.rebalanceCount >= SESSION_REBALANCE_CAP) {
        console.log(
          JSON.stringify({
            error: `Session cap of ${SESSION_REBALANCE_CAP} rebalances reached. Halting.`,
          })
        );
        process.exit(0);
      }

      const now = Math.floor(Date.now() / 1000);
      const secondsSinceLast = now - state.lastRebalanceTs;
      if (state.lastRebalanceTs > 0 && secondsSinceLast < COOLDOWN_SECONDS) {
        console.log(
          JSON.stringify({
            status: "cooldown",
            secondsRemaining: COOLDOWN_SECONDS - secondsSinceLast,
          })
        );
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const healthy = await fetchApiHealth(config.apiKey);
      if (!healthy) {
        console.log(
          JSON.stringify({ error: "Bitflow API health check failed. Skipping cycle." })
        );
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const poolBins = await fetchPoolBins(config.poolId, config.apiKey);
      const activeBin = poolBins.active_bin_id;

      if (!activeBin) {
        console.log(
          JSON.stringify({ error: "Could not determine active bin from pool data." })
        );
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const userPositionBins = await fetchUserPositionBins(
        config.address,
        config.poolId,
        config.apiKey
      );

      const binsWithLiquidity = (userPositionBins.bins || []).filter(
        (b) => b.user_liquidity > 0
      );

      if (binsWithLiquidity.length === 0) {
        console.log(
          JSON.stringify({ error: "No liquidity found in pool for this address." })
        );
        process.exit(1);
      }

      const lowerBin = Math.min(...binsWithLiquidity.map((b) => b.bin_id));
      const upperBin = Math.max(...binsWithLiquidity.map((b) => b.bin_id));
      const inRange = activeBin >= lowerBin && activeBin <= upperBin;

      if (inRange) {
        console.log(
          JSON.stringify({
            status: "in-range",
            action: "none",
            position: { activeBin, depositedRange: { lower: lowerBin, upper: upperBin } },
            timestamp: now,
          })
        );
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const slippage = estimateSlippage(binsWithLiquidity, activeBin, lowerBin, upperBin);
      if (slippage > config.maxSlippage) {
        console.log(
          JSON.stringify({
            error: `Slippage ${slippage.toFixed(2)}% exceeds configured max of ${config.maxSlippage}%. Rebalance aborted.`,
          })
        );
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const { lowerOffset, upperOffset } = computeNewRangeOffsets(lowerBin, upperBin, activeBin);
      const newLower = activeBin + lowerOffset;
      const newUpper = activeBin + upperOffset;

      if (config.dryRun) {
        console.log(
          JSON.stringify({
            status: "dry-run",
            action: "bin-range-shift",
            previousRange: { lower: lowerBin, upper: upperBin },
            newRange: { lower: newLower, upper: newUpper },
            activeBin,
            estimatedSlippage: slippage,
            timestamp: now,
          })
        );
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const poolData = await fetchPoolData(config.poolId, config.apiKey);
      const txId = await executeMoveRelativeLiquidity(
        config,
        binsWithLiquidity,
        activeBin,
        poolData
      );

      state.lastRebalanceTs = now;
      state.rebalanceCount++;

      console.log(
        JSON.stringify({
          status: "rebalanced",
          action: "bin-range-shift",
          previousRange: { lower: lowerBin, upper: upperBin },
          newRange: { lower: newLower, upper: newUpper },
          activeBin,
          txId,
          rebalanceCount: state.rebalanceCount,
          timestamp: now,
        })
      );
    } catch (err: any) {
      console.log(JSON.stringify({ error: err.message || String(err) }));
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const program = new Command();

program
  .name("hodlmm-range-rebalancer")
  .description(
    "Monitors a Bitflow HODLMM position and autonomously rebalances when out of range"
  )
  .version("1.0.0");

const sharedOptions = (cmd: Command) =>
  cmd
    .requiredOption("--pool <poolId>", "HODLMM pool ID (e.g. hodlmm-sbtc-usdcx)")
    .option("--address <address>", "Stacks wallet address", process.env.STACKS_ADDRESS || "")
    .option("--api-key <key>", "Bitflow API key", process.env.BFF_API_KEY || "");

sharedOptions(
  program
    .command("doctor")
    .description("Validate API connectivity, wallet, pool access, and network")
).action(async (opts) => {
  await runDoctor({ poolId: opts.pool, address: opts.address, maxSlippage: 1, feeCap: 0, dryRun: false, apiKey: opts.apiKey });
});

sharedOptions(
  program
    .command("status")
    .description("Return current position state — active bin, range, in/out of range")
).action(async (opts) => {
  if (!opts.address) {
    console.log(JSON.stringify({ error: "--address is required for status" }));
    process.exit(1);
  }
  await runStatus({ poolId: opts.pool, address: opts.address, maxSlippage: 1, feeCap: 0, dryRun: false, apiKey: opts.apiKey });
});

sharedOptions(
  program
    .command("run")
    .description("Start autonomous monitoring and rebalance when out of range")
)
  .option("--max-slippage <percent>", "Max allowed slippage %", parseFloat, 1)
  .option("--fee-cap <uSTX>", "Max transaction fee in uSTX (required)", parseInt, 0)
  .option("--dry-run", "Simulate rebalances without broadcasting", false)
  .action(async (opts) => {
    if (!opts.address) {
      console.log(JSON.stringify({ error: "--address is required for run" }));
      process.exit(1);
    }
    await runMonitor({ poolId: opts.pool, address: opts.address, maxSlippage: opts.maxSlippage, feeCap: opts.feeCap, dryRun: opts.dryRun, apiKey: opts.apiKey });
  });

program.parseAsync(process.argv);
