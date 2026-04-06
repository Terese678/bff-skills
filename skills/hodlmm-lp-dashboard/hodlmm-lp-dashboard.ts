#!/usr/bin/env bun
import { Command } from "commander";

// ─── Constants ────────────────────────────────────────────────────────────────

// FIX: use production API URL (was beta.bitflow.finance)
const BFF_API_BASE = "https://bff.bitflowapis.finance/api";
const RATE_LIMIT_MS = 5_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PositionBin {
  bin_id: number;
  user_liquidity: number;
  liquidity: number;
  reserve_x: number;
  reserve_y: number;
}

interface PoolData {
  pool_id: string;
  active_bin_id: number;
  x_token: string;
  y_token: string;
  pool_contract: string;
  bin_step: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let lastApiCallTime = 0;

async function rateLimitedFetch(url: string, options?: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastApiCallTime;
  if (elapsed < RATE_LIMIT_MS) await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  lastApiCallTime = Date.now();
  const res = await fetch(url, options);
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 30_000));
    return rateLimitedFetch(url, options);
  }
  return res;
}

function out(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function ts(): number {
  return Math.floor(Date.now() / 1000);
}

async function loadWallet(): Promise<{ address: string }> {
  const address =
    process.env.STACKS_ADDRESS ??
    process.env.AIBTC_STACKS_ADDRESS ??
    process.env.WALLET_ADDRESS;
  if (!address) throw new Error("No wallet address. Set STACKS_ADDRESS env var.");
  return { address };
}

function bffHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const key = process.env.BFF_API_KEY;
  if (key) h["X-API-Key"] = key;
  return h;
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function fetchPoolData(poolId: string): Promise<PoolData | null> {
  try {
    const res = await rateLimitedFetch(`${BFF_API_BASE}/app/v1/pools/${poolId}`, {
      headers: bffHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Pool API error: ${res.status}`);
    return (await res.json()) as PoolData;
  } catch {
    return null;
  }
}

async function fetchUserPositionBins(
  userAddress: string,
  poolId: string
): Promise<PositionBin[]> {
  const res = await rateLimitedFetch(
    `${BFF_API_BASE}/app/v1/users/${userAddress}/positions/${poolId}/bins`,
    { headers: bffHeaders() }
  );
  if (!res.ok) throw new Error(`Position bins API error: ${res.status}`);
  const data = await res.json();
  return (data.bins ?? []) as PositionBin[];
}

// ─── Subcommands ──────────────────────────────────────────────────────────────

async function runDoctor(options: { pool?: string }): Promise<void> {
  const checks: Record<string, string> = {
    api: "unreachable",
    wallet: "not-loaded",
    pool: "not-checked",
  };

  try {
    const res = await rateLimitedFetch(`${BFF_API_BASE}/validation/health`, {
      headers: bffHeaders(),
    });
    checks.api = res.ok ? "reachable" : `error-${res.status}`;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    checks.pool = "not-specified (use --pool <id>)";
  }

  out({ status: "ok", checks, timestamp: ts() });
}

async function runStatus(options: { pool: string }): Promise<void> {
  let wallet: { address: string };
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

  const binIds = userBins.map((b) => b.bin_id);
  const minBin = Math.min(...binIds);
  const maxBin = Math.max(...binIds);
  const outOfRange = pool.active_bin_id < minBin || pool.active_bin_id > maxBin;

  const totalLiquidity = userBins.reduce((s, b) => s + b.user_liquidity, 0);
  const totalReserveX = userBins.reduce((s, b) => s + b.reserve_x, 0);
  const totalReserveY = userBins.reduce((s, b) => s + b.reserve_y, 0);

  out({
    status: "success",
    dashboard: {
      poolId: options.pool,
      poolContract: pool.pool_contract,
      activeBinId: pool.active_bin_id,
      userBinRange: { from: minBin, to: maxBin },
      binCount: userBins.length,
      totalLiquidity,
      totalReserveX,
      totalReserveY,
      outOfRange,
      rebalanceRecommended: outOfRange,
    },
    timestamp: ts(),
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("hodlmm-lp-dashboard")
  .description("View Bitflow HODLMM liquidity position status and bin range")
  .version("1.0.0");

program
  .command("doctor")
  .description("Validate API connectivity and wallet access")
  // FIX: pool is now a CLI argument, not hardcoded
  .option("--pool <id>", "HODLMM pool ID to validate")
  .action(async (options) => { await runDoctor(options); });

program
  .command("status")
  .description("Show current position, bin range, and out-of-range status")
  // FIX: pool is now required CLI argument, not hardcoded to dlmm_3
  .requiredOption("--pool <id>", "HODLMM pool ID to check (e.g. dlmm_3)")
  .action(async (options) => { await runStatus(options); });

program.parseAsync(process.argv).catch((err) => {
  out({
    error: err instanceof Error ? err.message : String(err),
    code: "PARSE_ERROR",
    timestamp: Math.floor(Date.now() / 1000),
  });
  process.exit(1);
});
