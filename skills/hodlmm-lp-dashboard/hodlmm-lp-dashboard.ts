#!/usr/bin/env bun
import { Command } from "commander";

const BASE = "https://beta.bitflow.finance/api/bff-proxy";
const POOL_ID = "dlmm_3";

const program = new Command();
program.name("hodlmm-lp-dashboard").description("Personal LP dashboard for active Bitflow HODLMM positions");

program.command("doctor")
  .description("Check Bitflow API connectivity")
  .action(async () => {
    try {
      const res = await fetch(`${BASE}/api/quotes/v1/bins/${POOL_ID}`);
      if (res.ok) {
        console.log(JSON.stringify({ result: "ok", message: "Bitflow API reachable", pool: POOL_ID }));
      } else {
        console.log(JSON.stringify({ error: `API returned ${res.status}` }));
      }
    } catch (e) {
      console.log(JSON.stringify({ error: String(e) }));
    }
  });

program.command("my-position")
  .description("Full dashboard for your active HODLMM position")
  .requiredOption("--address <address>", "Your STX address")
  .action(async (opts) => {
    try {
      const [posRes, poolRes] = await Promise.all([
        fetch(`${BASE}/api/app/v1/users/${opts.address}/liquidity/${POOL_ID}`),
        fetch(`${BASE}/api/quotes/v1/bins/${POOL_ID}`)
      ]);

      if (!posRes.ok) {
        console.log(JSON.stringify({ error: `No position found for ${opts.address}` }));
        return;
      }

      const pos = await posRes.json();
      const pool = await poolRes.json();

      const inRange = pos.priceRange?.coversActiveBin ?? false;
      const activeBin = pool.active_bin_id;
      const userBins = pos.bins ?? [];
      const minUserBin = userBins.length ? Math.min(...userBins.map((b: any) => b.bin_id)) : null;
      const maxUserBin = userBins.length ? Math.max(...userBins.map((b: any) => b.bin_id)) : null;
      const binsFromRange = minUserBin && activeBin < minUserBin ? minUserBin - activeBin : 0;

      const stxAmount = pos.totalLiquidity?.tokenX?.amount ?? 0;
      const usdcxAmount = pos.totalLiquidity?.tokenY?.amount ?? 0;
      const totalUsd = pos.totalValueUsd ?? 0;
      const earningsUsd = pos.userEarningsUsd ?? 0;

      const composition = stxAmount > 0 && usdcxAmount === 0
        ? "100% STX — price is below your range"
        : usdcxAmount > 0 && stxAmount === 0
        ? "100% USDCx — price is above your range"
        : `${((stxAmount / (stxAmount + usdcxAmount)) * 100).toFixed(1)}% STX / ${((usdcxAmount / (stxAmount + usdcxAmount)) * 100).toFixed(1)}% USDCx`;

      const action = inRange ? (binsFromRange < 5 ? "watch" : "hold") : "rebalance";
      const actionReason = inRange
        ? `Position in range — earning fees. Active bin ${activeBin} is within your range.`
        : `Out of range by ${binsFromRange} bins. Active bin ${activeBin} is below your range floor of ${minUserBin}. Earning 0% fees.`;

      console.log(JSON.stringify({
        result: "success",
        details: {
          address: opts.address,
          pool: POOL_ID,
          inRange,
          activeBin,
          userBinRange: { min: minUserBin, max: maxUserBin },
          binsFromRange,
          composition,
          stxAmount,
          usdcxAmount,
          totalValueUsd: totalUsd,
          earningsUsd,
          action,
          actionReason
        }
      }));
    } catch (e) {
      console.log(JSON.stringify({ error: String(e) }));
    }
  });

program.command("pool-status")
  .description("Current pool active bin and range data")
  .action(async () => {
    try {
      const res = await fetch(`${BASE}/api/quotes/v1/bins/${POOL_ID}`);
      if (!res.ok) {
        console.log(JSON.stringify({ error: `Pool fetch failed: ${res.status}` }));
        return;
      }
      const data = await res.json();
      console.log(JSON.stringify({
        result: "success",
        details: {
          pool: POOL_ID,
          activeBinId: data.active_bin_id,
          totalBins: data.total_bins
        }
      }));
    } catch (e) {
      console.log(JSON.stringify({ error: String(e) }));
    }
  });

program.parse();
