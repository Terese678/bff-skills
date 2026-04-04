---
name: hodlmm-compounder
description: "Autonomously harvests accumulated trading fees from a Bitflow HODLMM liquidity position and reinvests them back into the same pool, compounding yield without manual intervention."
metadata:
  author: "Terese678"
  author-agent: "Bitflow Agent"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "hodlmm-compounder/hodlmm-compounder.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, hodlmm, bitflow, yield, stacks, mainnet-only"
---

# hodlmm-compounder

Automatically harvests accumulated trading fees from a Bitflow HODLMM concentrated liquidity position and reinvests them back into the same pool. Turns passive fee accumulation into compounding yield — no manual claiming required.

## What It Does

- Checks unclaimed fee balance on a HODLMM LP position via the Bitflow API
- Evaluates whether fees meet a minimum harvest threshold (configurable)
- If threshold is met, signs and broadcasts a `collect-fees` transaction
- Immediately reinvests harvested fees back into the same pool via `add-liquidity`
- Enforces spend limits, cooldowns, and dry-run mode before any live execution
- Emits structured JSON for every action — harvest amounts, txIds, reinvest results

## Subcommands

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
    "unclaimedFeeTokenX": 0.00012,
    "unclaimedFeeTokenY": 1.45,
    "unclaimedFeeUSD": 8.20,
    "thresholdUSD": 5.00,
    "compoundReady": true,
    "estimatedAPYBoost": "0.3%"
  },
  "timestamp": 1712000000
}
```

**run (compound cycle):**
```json
{
  "status": "compounded",
  "harvestTxId": "0xabc123...",
  "reinvestTxId": "0xdef456...",
  "harvested": {
    "tokenX": 0.00012,
    "tokenY": 1.45,
    "usdValue": 8.20
  },
  "reinvested": {
    "tokenX": 0.00012,
    "tokenY": 1.45
  },
  "compoundCount": 1,
  "timestamp": 1712000000
}
```

## Safety Limits

| Limit | Value | Description |
|-------|-------|-------------|
| Min harvest threshold | Configurable USD | Skip harvest if fees below this value |
| Max fee per tx | `--fee-cap` (required) | Refuses to sign above this STX amount |
| Cooldown | 3600s | Minimum time between compound cycles |
| Max compounds | 24 | Hard stop after 24 compounds per session |
| Slippage | `--max-slippage` | Reinvest aborted if slippage exceeds limit |
| Dry-run | `--dry-run` flag | Simulates full cycle without broadcasting |

## Example Usage

```bash
# Check environment
bun run hodlmm-compounder.ts doctor --pool hodlmm-sbtc-usdcx

# Check unclaimed fees
bun run hodlmm-compounder.ts status --pool hodlmm-sbtc-usdcx

# Dry run first
bun run hodlmm-compounder.ts run --pool hodlmm-sbtc-usdcx --dry-run

# Live compounding with limits
bun run hodlmm-compounder.ts run --pool hodlmm-sbtc-usdcx --fee-cap 3 --min-harvest 5 --max-slippage 0.01
```
