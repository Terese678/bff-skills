#!/usr/bin/env bun
import { Command } from "commander";

const BASE = "https://api.bitflow.finance/api/v1";

const program = new Command();
program.name("hodlmm-lp-dashboard").description("Personal LP dashboard for active Bitflow HODLMM positions");

program.command("doctor")
  .description("Check Bitflow API connectivity")
  .action(async () => {
    try {
      const res = await fetch(`${BASE}/pools`);
      if (res.ok) console.log(JSON.stringify({ result: "ok", message: "Bitflow API reachable" }));
      else console.log(JSON.stringify({ result: "error", status: res.status }));
    } catch (e) {
      console.log(JSON.stringify({ result: "error", message: String(e) }));
    }
  });

program.command("my-position")
  .description("Full dashboard for your active HODLMM position")
  .requiredOption("--address <address>", "Your STX address")
  .requiredOption("--pool-id <poolId>", "Pool ID e.g. dlmm_1")
  .action(async (opts) => {
    try {
      const res = await fetch(`${BASE}/dlmm/pools/${opts.poolId}/positions/${opts.address}`);
      if (!res.ok) { console.log(JSON.stringify({ error: `No position found for ${opts.address} in pool ${opts.poolId}` })); return; }
      const data = await res.json();
      const inRange = data.in_range ?? false;
      const stxPct = data.token_a_pct ?? 100;
      const usdcPct = data.token_b_pct ?? 0;
      const apr = data.fee_apr ?? "0%";
      const bins = data.bins_from_edge ?? 0;
      console.log(JSON.stringify({
        result: "success",
        position: { inRange, binsFromNearestEdge: bins },
        composition: { STXPct: stxPct, USDCxPct: usdcPct, note: inRange ? "Mixed — position holds both tokens" : stxPct === 100 ? "All STX — price below range" : "All USDCx — price above range" },
        yield: { currentlyEarning: inRange, feeAprEstimate: inRange ? apr : "0%" },
        action: inRange && bins > 3 ? "hold" : inRange ? "watch" : "rebalance",
        actionReason: inRange ? `Position healthy — earning ${apr} APR` : `Earning 0% fees. Rebalance to re-enter range.`
      }));
    } catch (e) {
      console.log(JSON.stringify({ error: String(e) }));
    }
  });

program.command("earnings")
  .description("Quick earnings snapshot")
  .requiredOption("--address <address>", "Your STX address")
  .requiredOption("--pool-id <poolId>", "Pool ID")
  .action(async (opts) => {
    try {
      const res = await fetch(`${BASE}/dlmm/pools/${opts.poolId}/positions/${opts.address}`);
      if (!res.ok) { console.log(JSON.stringify({ error: "Position not found" })); return; }
      const data = await res.json();
      console.log(JSON.stringify({
        earning: data.in_range ?? false,
        apr: data.in_range ? (data.fee_apr ?? "0%") : "0%",
        note: data.in_range ? "In range — capturing fees" : "Out of range — earning nothing"
      }));
    } catch (e) {
      console.log(JSON.stringify({ error: String(e) }));
    }
  });

program.command("keeper-status")
  .description("Check keeper automation status")
  .requiredOption("--pool-id <poolId>", "Pool ID")
  .action(async (opts) => {
    try {
      const res = await fetch(`${BASE}/dlmm/pools/${opts.poolId}`);
      if (!res.ok) { console.log(JSON.stringify({ error: "Pool not found" })); return; }
      const data = await res.json();
      console.log(JSON.stringify({
        poolId: opts.poolId,
        keeperEnabled: data.keeper_enabled ?? false,
        note: data.keeper_enabled ? "Keeper active — auto rebalancing enabled" : "No keeper — manual monitoring required"
      }));
    } catch (e) {
      console.log(JSON.stringify({ error: String(e) }));
    }
  });

program.parse();
