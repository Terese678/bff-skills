---
name: hodlmm-compounder
description: "Autonomously harvests accumulated trading fees from a Bitflow HODLMM liquidity position and reinvests them back into the same pool, compounding yield without manual intervention."
metadata:
  author: "Terese678"
  author-agent: "Terese Agent"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "hodlmm-compounder/hodlmm-compounder.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# hodlmm-compounder

Automatically harvests accumulated trading fees from a Bitflow HODLMM concentrated liquidity position and reinvests them back into the same pool. Turns passive fee accumulation into compounding yield — no manual claiming required.

## Why agents need it

An agent holding a HODLMM position needs to periodically harvest and reinvest fees to compound yield. Without automation, fees accumulate unclaimed. This skill runs that two-step cycle autonomously — checking thresholds, collecting fees, and reinvesting in a single operation with configurable safety limits.

## What It Does

- Checks unclaimed fee balance on a HODLMM LP position via the Bitflow API
- Evaluates whether fees meet a minimum harvest threshold (configurable)
- If threshold is met, signs and broadcasts a `withdraw-liquidity-multi` transaction
- Immediately reinvests harvested fees back into the same pool via `add-relative-liquidity-same-multi`
- Enforces spend limits, cooldowns, and dry-run mode before any live execution
- Emits structured JSON for every action — harvest amounts, txIds, reinvest results

## Commands

| Command | Description |
|---------|-------------|
| `doctor` | Validates API connectivity, wallet config, and pool access |
| `status` | Returns current unclaimed fees and compound opportunity estimate |
| `run` | Starts autonomous compound loop — harvest + reinvest on threshold |

## Output Contract

All output is strict JSON to stdout.

**doctor:**
```json
{
  "status": "ok",
  "checks": {
    "api": "reachable",
    "wallet": "loaded",
    "pool": "found",
    "network": "mainnet"
  },
  "timestamp": 1712000000
}
```

**status:**
```json
{
  "status": "success",
  "position": {
    "poolId": "hodlmm-sbtc-usdcx",
    "accumulatedFeesX": 1200,
    "accumulatedFeesY": 800,
    "totalLiquidity": 50000,
    "compoundThresholdMet": true,
    "estimatedCompoundBoostBps": 40
  },
  "timestamp": 1712000000
}
```

**run (compound cycle):**
```json
{
  "status": "compounded",
  "action": "harvest-and-reinvest",
  "harvestedFeesX": 1200,
  "harvestedFeesY": 800,
  "reinvestedBins": [{ "binId": 8388700, "xAmount": 1200, "yAmount": 800 }],
  "harvestTxId": "0xabc123...",
  "reinvestTxId": "0xdef456...",
  "compoundCount": 1,
  "timestamp": 1712000000
}
```

## Safety notes

| Limit | Value | Description |
|-------|-------|-------------|
| Min harvest threshold | Configurable uSTX (default: 10000) | Skip harvest if fees below this value |
| Max fee per tx | `--fee-cap` (required) | Refuses to sign above this STX amount |
| Cooldown | 3600s | Minimum time between compound cycles |
| Max compounds | 20 | Hard stop after 20 compounds per session |
| Slippage | `--max-slippage` | Reinvest aborted if slippage exceeds limit |
| Dry-run | `--dry-run` flag | Simulates full cycle without broadcasting |

## Example Usage

```bash
# Check environment
bun run hodlmm-compounder.ts doctor --pool dlmm_3

# Check unclaimed fees
bun run hodlmm-compounder.ts status --pool dlmm_3

# Dry run first
bun run hodlmm-compounder.ts run --pool dlmm_3 --dry-run

# Live compounding with limits
bun run hodlmm-compounder.ts run --pool dlmm_3 --fee-cap 3 --min-threshold 10000 --max-slippage 0.01
```