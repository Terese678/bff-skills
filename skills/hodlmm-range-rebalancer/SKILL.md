---
name: hodlmm-range-rebalancer
description: "Monitors a Bitflow HODLMM liquidity position and autonomously rebalances the bin range when the active bin moves outside the deposited range, preserving yield continuity."
metadata:
  author: "Terese678"
  author-agent: "Bitflow Agent"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "hodlmm-range-rebalancer/hodlmm-range-rebalancer.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, hodlmm, bitflow, stacks, mainnet-only"
---

# hodlmm-range-rebalancer

## What it does
Monitors a Bitflow HODLMM concentrated liquidity position and autonomously executes a bin range rebalance when the active trading bin drifts outside the LP's deposited range. Detects out-of-range positions in real time and re-centers the bin range on the current active bin using `move-relative-liquidity-multi` (Simple mode). Stops yield loss from out-of-range positions before it compounds.

## Why agents need it
An out-of-range HODLMM position earns zero trading fees ΓÇö silently. A human LP cannot monitor bin drift 24/7, but an agent can. This skill gives an autonomous agent the ability to detect range drift and immediately rebalance without human intervention, keeping the position fee-generating at all times. Without this skill, an agent has no way to recover a concentrated liquidity position that has drifted out of range.

## Safety notes
- **This skill writes to chain.** It submits a `move-relative-liquidity-multi` transaction on Stacks mainnet.
- **This skill moves funds.** It withdraws liquidity from out-of-range bins and re-deposits into a new centered range.
- **Mainnet only.** This skill will not run on testnet.
- **Irreversible actions.** Rebalance transactions cannot be undone once broadcast.
- Requires `--fee-cap` to be set ΓÇö no transaction executes without an explicit spend limit.
- Enforces a 3600s cooldown between rebalances and a hard session cap of 10 rebalances.
- Slippage is estimated before every rebalance ΓÇö aborts if estimated slippage exceeds `--max-slippage`.

## Commands

### doctor
Checks API health, wallet readiness, pool access, and network. Safe to run anytime.
```bash
bun run hodlmm-range-rebalancer/hodlmm-range-rebalancer.ts doctor --pool hodlmm-sbtc-usdcx
```

### status
Read-only position check ΓÇö returns active bin, deposited range, and whether position is in or out of range.
```bash
bun run hodlmm-range-rebalancer/hodlmm-range-rebalancer.ts status --pool hodlmm-sbtc-usdcx --address SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K
```

### run
Starts autonomous monitoring loop. On each cycle: checks cooldown, fetches active bin, detects range drift, estimates slippage, and executes rebalance if out of range and within safety limits.
```bash
# Dry run first ΓÇö always
bun run hodlmm-range-rebalancer/hodlmm-range-rebalancer.ts run --pool hodlmm-sbtc-usdcx --address SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K --dry-run --fee-cap 10000

# Live rebalancing
bun run hodlmm-range-rebalancer/hodlmm-range-rebalancer.ts run --pool hodlmm-sbtc-usdcx --address SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K --max-slippage 1 --fee-cap 10000
```

## Output contract

All outputs are strict JSON to stdout.

**doctor:**
```json
{
  "status": "ok",
  "checks": {
    "api": "reachable",
    "wallet": "loaded",
    "pool": "found",
    "network": "mainnet"
  }
}
```

**status:**
```json
{
  "status": "success",
  "position": {
    "poolId": "hodlmm-sbtc-usdcx",
    "activeBin": 8421,
    "depositedRange": { "lower": 8300, "upper": 8400 },
    "inRange": false,
    "rebalanceRecommended": true
  },
  "timestamp": 1712000000
}
```

**run ΓÇö rebalanced:**
```json
{
  "status": "rebalanced",
  "action": "bin-range-shift",
  "previousRange": { "lower": 8300, "upper": 8400 },
  "newRange": { "lower": 8371, "upper": 8471 },
  "activeBin": 8421,
  "txId": "0xabc123...",
  "timestamp": 1712000000
}
```

**run ΓÇö in range, no action:**
```json
{
  "status": "in-range",
  "action": "none",
  "position": {
    "activeBin": 8350,
    "depositedRange": { "lower": 8300, "upper": 8400 }
  },
  "timestamp": 1712000000
}
```

**error:**
```json
{
  "error": "Slippage 2.4% exceeds configured max of 1%. Rebalance aborted."
}
```

## Known constraints
- Requires `STACKS_PRIVATE_KEY` environment variable for write operations
- Requires `STACKS_ADDRESS` or `--address` flag for position lookups
- Pool ID must match a valid Bitflow HODLMM pool (e.g. `hodlmm-sbtc-usdcx`)
- Cooldown of 3600s between rebalances is hardcoded and not configurable
- Session cap of 10 rebalances per `run` invocation is hardcoded
- If user has zero liquidity in the pool, skill exits with error
- Simple mode (`move-relative-liquidity-multi`) uses `PostConditionMode.Allow`
- API key (`BFF_API_KEY` or `--api-key`) may be required depending on Bitflow API tier

## API Reference

Uses the official Bitflow HODLMM API (`https://bff.bitflowapis.finance/api`):

- `GET /api/validation/health` ΓÇö API health check
- `GET /app/v1/users/{address}/liquidity/{pool_id}` ΓÇö User LP position
- `GET /app/v1/users/{address}/positions/{pool_id}/bins` ΓÇö User position bins
- `GET /quotes/v1/bins/{pool_id}` ΓÇö Pool bins and active bin
- `GET /app/v1/pools/{pool_id}` ΓÇö Pool data including token contracts

Rebalancing uses `SP3ESW1QCNQPVXJDGQWT7E45RDCH38QBK9HEJSX4X.dlmm-liquidity-router-v-0-1` via `move-relative-liquidity-multi` (Simple mode).
