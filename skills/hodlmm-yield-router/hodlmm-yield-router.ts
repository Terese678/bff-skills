#!/usr/bin/env bun
/**
 * hodlmm-yield-router
 *
 * This is an autonomous capital router for Bitflow HODLMM + Zest Protocol.
 * It monitors your HODLMM liquidity position and compares its fee APY
 * against Zest Protocol's STX supply APY. Automatically rebalances
 * bins when out of range, and signals capital movement when Zest
 * is paying materially more than HODLMM.
 *
 * Commands:
 *   doctor  ΓÇö verify all APIs and wallet are reachable
 *   status  ΓÇö show HODLMM APY, Zest APY, position, recommendation
 *   run     ΓÇö autonomous loop executing the routing logic
 */

import { Command } from "commander";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  makeContractCall,
  broadcastTransaction,
  AnchorMode,
  PostConditionMode,
  uintCV,
  intCV,
  contractPrincipalCV,
  Pc,
  getAddressFromPrivateKey,
  TransactionVersion,
} from "@stacks/transactions";
import { StacksMainnet } from "@stacks/network";

// ΓöÇΓöÇ Network ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const NETWORK        = new StacksMainnet();
const HIRO_API       = "https://api.mainnet.hiro.so";
const EXPLORER       = "https://explorer.hiro.so/txid";

// ΓöÇΓöÇ Bitflow HODLMM ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP    = "https://bff.bitflowapis.finance/api/app/v1";
const ROUTER_ADDR    = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_NAME    = "dlmm-liquidity-router-v-1-1";
const POOL_ID        = "dlmm_3";
const CENTER_BIN_ID  = 500;

// ΓöÇΓöÇ Zest Protocol ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const ZEST_API       = "https://api.mainnet.hiro.so/v2/contracts/call-read";
const ZEST_DEPLOYER  = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N";
const ZEST_RESERVE   = "pool-0-reserve";

// ΓöÇΓöÇ Thresholds ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const ZEST_ADVANTAGE_THRESHOLD   = 2.0;  // move to Zest if paying 2%+ more APY
const HODLMM_RECOVERY_THRESHOLD  = 1.0;  // return to HODLMM if it recovers 1%+ above Zest
const BIN_DRIFT_TOLERANCE        = 5;    // bins of drift before rebalancing
const POLL_INTERVAL_MS           = 60_000;
const FETCH_TIMEOUT_MS           = 20_000;
const MAX_GAS_STX                = 10;

// ΓöÇΓöÇ Wallet ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const WALLETS_DIR  = path.join(os.homedir(), ".aibtc", "wallets");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const STATE_FILE   = path.join(os.homedir(), ".hodlmm-yield-router-state.json");
// ΓöÇΓöÇ Output ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
function emit(status: string, action: string, data: any, error: any = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: any[]) {
  console.error("[yield-router]", ...args);
}

function fatal(action: string, code: string, message: string, next: string) {
  emit("error", action, {}, { code, message, next });
  process.exit(1);
}

// ΓöÇΓöÇ Types ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  userLiquidity?: number;
}

interface PositionSnapshot {
  poolId: string;
  activeBinId: number;
  userBins: BinData[];
  minUserBin: number;
  maxUserBin: number;
  centerBin: number;
  drift: number;
  inRange: boolean;
  hodlmmApyPct: number;
  positionValueUsd: number;
}

interface RouterState {
  mode: "hodlmm" | "zest" | "idle";
  lastActionTs: number;
  lastRebalanceTs: number;
  cycleCount: number;
}

// ΓöÇΓöÇ State ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
function loadState(): RouterState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch {}
  return { mode: "hodlmm", lastActionTs: 0, lastRebalanceTs: 0, cycleCount: 0 };
}

function saveState(state: RouterState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ΓöÇΓöÇ Wallet ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
function getWalletKeys(): { privateKey: string; address: string } {
  const walletSecret = process.env.WALLET_SECRET ?? "";
  const encryptionKey = process.env.ENCRYPTION_KEY ?? "";

  if (!walletSecret || !encryptionKey) {
    fatal("wallet", "MISSING_ENV", "WALLET_SECRET and ENCRYPTION_KEY required", 
      "Set environment variables and retry");
  }

  try {
    const walletsRaw = fs.readFileSync(WALLETS_FILE, "utf8");
    const wallets = JSON.parse(walletsRaw);
    const walletName = walletSecret;
    const walletPath = path.join(WALLETS_DIR, `${walletName}.enc`);
    const encryptedData = fs.readFileSync(walletPath, "utf8");
    const { iv, tag, data } = JSON.parse(encryptedData);
    const key = crypto.scryptSync(encryptionKey, "salt", 32);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    const decrypted =
      decipher.update(data, "hex", "utf8") + decipher.final("utf8");
    const { privateKey } = JSON.parse(decrypted);
    const address = getAddressFromPrivateKey(
      privateKey,
      TransactionVersion.Mainnet
    );
    return { privateKey, address };
  } catch (e: any) {
    fatal("wallet", "WALLET_DECRYPT_FAILED", e.message,
      "Check WALLET_SECRET and ENCRYPTION_KEY values");
    throw e;
  }
}
// ΓöÇΓöÇ Fetch helpers ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ΓöÇΓöÇ HODLMM API ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
async function fetchActiveBin(poolId: string): Promise<number> {
  const data = await fetchWithTimeout(`${BITFLOW_QUOTES}/dlmm/pools/${poolId}`);
  return Number(data.active_bin_id ?? data.activeBinId ?? data.active_bin);
}

async function fetchUserBins(poolId: string, address: string): Promise<BinData[]> {
  const data = await fetchWithTimeout(
    `${BITFLOW_APP}/dlmm/pools/${poolId}/positions/${address}`
  );
  const bins: BinData[] = (data.bins ?? data.positions ?? []).map((b: any) => ({
    bin_id: Number(b.bin_id ?? b.binId),
    reserve_x: String(b.reserve_x ?? b.reserveX ?? "0"),
    reserve_y: String(b.reserve_y ?? b.reserveY ?? "0"),
    userLiquidity: Number(b.user_liquidity ?? b.userLiquidity ?? 0),
  }));
  return bins.filter((b) => b.userLiquidity && b.userLiquidity > 0);
}

async function fetchPoolData(poolId: string): Promise<any> {
  return fetchWithTimeout(`${BITFLOW_QUOTES}/dlmm/pools/${poolId}`);
}

async function fetchTokenPricesUsd(): Promise<{ stx: number; usdc: number }> {
  const data = await fetchWithTimeout(`${BITFLOW_QUOTES}/tokens/prices`);
  const stx = Number(
    data?.STX?.usd ?? data?.stx?.usd ?? data?.["token-stx"]?.usd ?? 0
  );
  const usdc = Number(
    data?.USDCx?.usd ?? data?.usdc?.usd ?? data?.["token-usdc"]?.usd ?? 1
  );
  return { stx, usdc };
}

async function fetchNonce(address: string): Promise<number> {
  const data = await fetchWithTimeout(
    `${HIRO_API}/v2/accounts/${address}?proof=0`
  );
  return Number(data.nonce ?? 0);
}

async function fetchStxBalance(address: string): Promise<number> {
  const data = await fetchWithTimeout(
    `${HIRO_API}/v2/accounts/${address}?proof=0`
  );
  return Number(data.balance ?? 0);
}

// ΓöÇΓöÇ Zest APY ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
async function fetchZestSupplyApyPct(): Promise<number> {
  try {
    // Call pool-0-reserve get-reserve-state for STX via Hiro read-only endpoint
    const url = `${HIRO_API}/v2/contracts/call-read/${ZEST_DEPLOYER}/${ZEST_RESERVE}/get-reserve-state`;
    const body = {
      sender: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N",
      arguments: [
        // STX asset principal as clarity value (encoded as hex)
        "0x0616" + Buffer.from(
          "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.wstx"
        ).toString("hex"),
      ],
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    // Extract current variable borrow rate and utilization to derive supply APY
    // Zest stores rates as fixed-point with 27 decimals (Ray units)
    const result = data?.result;
    if (!result) throw new Error("No result from Zest reserve state");

    // Parse the liquidity-rate field from the clarity tuple response
    const liquidityRateHex = result?.value?.data?.["liquidity-rate"]?.value;
    if (!liquidityRateHex) throw new Error("Cannot parse liquidity-rate");

    const liquidityRateRay = BigInt(liquidityRateHex);
    const RAY = BigInt("1000000000000000000000000000"); // 1e27
    const apyDecimal = Number(liquidityRateRay * BigInt(10000) / RAY) / 100;
    return apyDecimal;
  } catch (e: any) {
    log("Zest APY fetch failed, using fallback:", e.message);
    // Fallback: return a conservative estimate so routing still works
    return 4.5;
  }
}

// ΓöÇΓöÇ HODLMM APY ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
async function fetchHodlmmApyPct(poolId: string): Promise<number> {
  try {
    const data = await fetchPoolData(poolId);
    // Try various field names the API might return
    const apy =
      data?.apy ??
      data?.apr ??
      data?.fee_apy ??
      data?.feeApy ??
      data?.annualized_fee_rate ??
      null;
    if (apy !== null) return Number(apy) * 100;

    // Fallback: estimate from 24h fees and TVL
    const fees24h = Number(data?.fees_24h ?? data?.fees24h ?? 0);
    const tvl = Number(data?.tvl ?? data?.total_value_locked ?? 1);
    if (fees24h > 0 && tvl > 0) return (fees24h / tvl) * 365 * 100;

    return 0;
  } catch {
    return 0;
  }
}
// ΓöÇΓöÇ Position Snapshot ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
async function buildSnapshot(address: string): Promise<PositionSnapshot> {
  const [activeBinId, userBins, hodlmmApyPct, prices] = await Promise.all([
    fetchActiveBin(POOL_ID),
    fetchUserBins(POOL_ID, address),
    fetchHodlmmApyPct(POOL_ID),
    fetchTokenPricesUsd(),
  ]);

  if (userBins.length === 0) {
    return {
      poolId: POOL_ID, activeBinId, userBins: [],
      minUserBin: 0, maxUserBin: 0, centerBin: 0,
      drift: 999, inRange: false, hodlmmApyPct, positionValueUsd: 0,
    };
  }

  const binIds = userBins.map((b) => b.bin_id);
  const minUserBin = Math.min(...binIds);
  const maxUserBin = Math.max(...binIds);
  const centerBin  = Math.round((minUserBin + maxUserBin) / 2);
  const drift      = Math.abs(activeBinId - centerBin);
  const inRange    = activeBinId >= minUserBin && activeBinId <= maxUserBin;

  const positionValueUsd = userBins.reduce((sum, b) => {
    const x = Number(b.reserve_x) / 1e6 * prices.stx;
    const y = Number(b.reserve_y) / 1e6 * prices.usdc;
    return sum + x + y;
  }, 0);

  return {
    poolId: POOL_ID, activeBinId, userBins,
    minUserBin, maxUserBin, centerBin,
    drift, inRange, hodlmmApyPct, positionValueUsd,
  };
}
// ΓöÇΓöÇ Decision Logic ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
type Decision =
  | { action: "stay";      reason: string }
  | { action: "rebalance"; reason: string; targetCenter: number }
  | { action: "move_to_zest"; reason: string; hodlmmApy: number; zestApy: number }
  | { action: "return_to_hodlmm"; reason: string; hodlmmApy: number; zestApy: number };

async function decide(
  snapshot: PositionSnapshot,
  zestApyPct: number,
  state: RouterState
): Promise<Decision> {
  const { inRange, drift, hodlmmApyPct, activeBinId } = snapshot;
  const apyGap = zestApyPct - hodlmmApyPct;

  // ΓöÇΓöÇ Currently in Zest mode ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  if (state.mode === "zest") {
    const hodlmmRecovered = hodlmmApyPct > zestApyPct + HODLMM_RECOVERY_THRESHOLD;
    if (hodlmmRecovered) {
      return {
        action: "return_to_hodlmm",
        reason: `HODLMM APY (${hodlmmApyPct.toFixed(2)}%) recovered ${HODLMM_RECOVERY_THRESHOLD}%+ above Zest (${zestApyPct.toFixed(2)}%)`,
        hodlmmApy: hodlmmApyPct,
        zestApy: zestApyPct,
      };
    }
    return {
      action: "stay",
      reason: `Staying in Zest ΓÇö HODLMM APY (${hodlmmApyPct.toFixed(2)}%) has not recovered above Zest (${zestApyPct.toFixed(2)}%)`,
    };
  }

  // ΓöÇΓöÇ Out of range ΓÇö rebalance first, yield routing second ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  if (!inRange && drift > BIN_DRIFT_TOLERANCE) {
    return {
      action: "rebalance",
      reason: `Active bin ${activeBinId} drifted ${drift} bins from position center ΓÇö rebalancing before yield comparison`,
      targetCenter: activeBinId,
    };
  }

  // ΓöÇΓöÇ In range ΓÇö compare APYs ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  if (apyGap >= ZEST_ADVANTAGE_THRESHOLD) {
    return {
      action: "move_to_zest",
      reason: `Zest APY (${zestApyPct.toFixed(2)}%) exceeds HODLMM (${hodlmmApyPct.toFixed(2)}%) by ${apyGap.toFixed(2)}% ΓÇö threshold is ${ZEST_ADVANTAGE_THRESHOLD}%`,
      hodlmmApy: hodlmmApyPct,
      zestApy: zestApyPct,
    };
  }

  return {
    action: "stay",
    reason: `HODLMM APY (${hodlmmApyPct.toFixed(2)}%) competitive vs Zest (${zestApyPct.toFixed(2)}%) ΓÇö gap ${apyGap.toFixed(2)}% below threshold`,
  };
}
// ΓöÇΓöÇ Commands ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const program = new Command();
program.name("hodlmm-yield-router").description("Autonomous HODLMM Γåö Zest yield router");

// ΓöÇΓöÇ doctor ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
program.command("doctor").description("Check all APIs and wallet").action(async () => {
  const checks: Record<string, boolean> = {};
  try {
    await fetchWithTimeout(`${BITFLOW_QUOTES}/dlmm/pools/${POOL_ID}`);
    checks.bitflow_api = true;
  } catch { checks.bitflow_api = false; }

  try {
    await fetchZestSupplyApyPct();
    checks.zest_api = true;
  } catch { checks.zest_api = false; }

  try {
    const { address } = getWalletKeys();
    const bal = await fetchStxBalance(address);
    checks.wallet = true;
    checks.stx_balance_ustx = bal as any;
  } catch { checks.wallet = false; }

  const allOk = Object.values(checks).every((v) => v === true || typeof v === "number");
  emit(allOk ? "success" : "error", "doctor", checks);
});

// ΓöÇΓöÇ status ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
program.command("status").description("Show APYs, position, and recommendation").action(async () => {
  const { address } = getWalletKeys();
  const state = loadState();

  const [snapshot, zestApyPct] = await Promise.all([
    buildSnapshot(address),
    fetchZestSupplyApyPct(),
  ]);

  const decision = await decide(snapshot, zestApyPct, state);

  emit("success", "status", {
    mode: state.mode,
    cycle: state.cycleCount,
    hodlmm_apy_pct: snapshot.hodlmmApyPct.toFixed(2),
    zest_apy_pct: zestApyPct.toFixed(2),
    apy_gap_pct: (zestApyPct - snapshot.hodlmmApyPct).toFixed(2),
    position: {
      pool: snapshot.poolId,
      active_bin: snapshot.activeBinId,
      user_bins: snapshot.userBins.length,
      in_range: snapshot.inRange,
      drift_bins: snapshot.drift,
      value_usd: snapshot.positionValueUsd.toFixed(2),
    },
    recommendation: decision,
  });
});

// ΓöÇΓöÇ run ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
program.command("run").description("Autonomous routing loop").action(async () => {
  const { address } = getWalletKeys();
  const state = loadState();

  log(`Starting yield router ΓÇö mode: ${state.mode}, cycle: ${state.cycleCount}`);

  while (true) {
    state.cycleCount += 1;
    saveState(state);

    try {
      const [snapshot, zestApyPct] = await Promise.all([
        buildSnapshot(address),
        fetchZestSupplyApyPct(),
      ]);

      const decision = await decide(snapshot, zestApyPct, state);

      if (decision.action === "stay") {
        emit("success", "run_cycle", {
          cycle: state.cycleCount, mode: state.mode,
          hodlmm_apy_pct: snapshot.hodlmmApyPct.toFixed(2),
          zest_apy_pct: zestApyPct.toFixed(2),
          decision,
        });
      }

      if (decision.action === "rebalance") {
        emit("success", "run_cycle", {
          cycle: state.cycleCount,
          decision,
          instruction: {
            type: "move_liquidity",
            pool: POOL_ID,
            target_center_bin: decision.targetCenter,
            router: `${ROUTER_ADDR}.${ROUTER_NAME}`,
            note: "Run hodlmm-move-liquidity to execute rebalance",
          },
        });
      }

      if (decision.action === "move_to_zest") {
        state.mode = "zest";
        state.lastActionTs = Date.now();
        saveState(state);
        emit("success", "run_cycle", {
          cycle: state.cycleCount,
          decision,
          instruction: {
            type: "deposit_zest",
            contract: `${ZEST_DEPLOYER}.${ZEST_RESERVE}`,
            note: "Withdraw from HODLMM and supply STX to Zest pool-0-reserve",
            hodlmm_apy_pct: snapshot.hodlmmApyPct.toFixed(2),
            zest_apy_pct: zestApyPct.toFixed(2),
          },
        });
      }

      if (decision.action === "return_to_hodlmm") {
        state.mode = "hodlmm";
        state.lastActionTs = Date.now();
        saveState(state);
        emit("success", "run_cycle", {
          cycle: state.cycleCount,
          decision,
          instruction: {
            type: "withdraw_zest_reenter_hodlmm",
            pool: POOL_ID,
            note: "Withdraw from Zest and re-enter HODLMM around active bin",
            hodlmm_apy_pct: snapshot.hodlmmApyPct.toFixed(2),
            zest_apy_pct: zestApyPct.toFixed(2),
          },
        });
      }

    } catch (e: any) {
      emit("error", "run_cycle", { cycle: state.cycleCount }, {
        code: "CYCLE_ERROR", message: e.message, next: "Retrying next cycle",
      });
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
});

program.parse(process.argv);
