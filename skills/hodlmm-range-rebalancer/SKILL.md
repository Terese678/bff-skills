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

Monitors a Bitflow HODLMM concentrated liquidity position and autonomously executes a bin range rebalance when the active trading bin drifts outside the LP's deposited range. Stops yield loss from out-of-range positions before it compounds.

## What It Does

- Polls the Bitflow HODLMM API for the current active bin and the agent's deposited bin range
- Detects when the active bin has moved outside the LP's range (position is out-of-range = earning zero fees)
- Uses `move-relative-liquidity-multi` (Simple mode) to shift bins relative to the new active bin — fewer failed transactions during fast price moves
- Signs and broadcasts the rebalance transaction via the AIBTC wallet
- Enforces hard spend limits and cooldowns — never rebalances more than once per hour or beyond configured slippage

## Subcommands

| Command | Description |
|---------|-------------|
| `doctor` | Validates API connectivity, wallet config, pool access, and API health via `/api/validation/health` |
| `status` | Returns current position state — active bin, deposited range, in/out of range |
| `run` | Starts autonomous monitoring and rebalances when out-of-range is detected |

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

**run (rebalance execution):**
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

**run (in range, no action):**
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

## Safety Limits

| Limit | Value | Description |
|-------|-------|-------------|
| Max slippage | 1% (default) | Rebalance aborted if estimated slippage exceeds limit |
| Cooldown | 3600s | Minimum time between rebalances |
| Max rebalances | 10 | Hard stop after 10 rebalances per run session |
| Spend cap | Operator-set via `--fee-cap` | No transaction executes above the configured uSTX fee cap |
| Dry-run mode | `--dry-run` flag | Simulates all actions without broadcasting |

The skill **refuses to run** without `--fee-cap` set. No spend limit = no execution.

## Refusal Conditions

The agent will output `{ "error": "..." }` and halt without executing any transaction if:

1. `--fee-cap` is not provided
2. Estimated slippage exceeds `--max-slippage`
3. Network is not mainnet
4. Wallet is not loaded or key is missing
5. API health check fails
6. Pool is not found or returns no bins
7. User has no liquidity in the pool
8. Cooldown period has not elapsed
9. Session rebalance cap (10) has been reached
10. Dry-run mode is active (simulates only)

## Example Usage

```bash
# Check environment and pool connectivity
bun run hodlmm-range-rebalancer.ts doctor --pool hodlmm-sbtc-usdcx

# Check current position status
bun run hodlmm-range-rebalancer.ts status --pool hodlmm-sbtc-usdcx --address SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K

# Start autonomous monitoring (dry run first — always)
bun run hodlmm-range-rebalancer.ts run --pool hodlmm-sbtc-usdcx --address SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K --dry-run --fee-cap 10000

# Start live autonomous rebalancing
bun run hodlmm-range-rebalancer.ts run --pool hodlmm-sbtc-usdcx --address SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K --max-slippage 1 --fee-cap 10000
```

## API Reference

This skill uses the official Bitflow HODLMM API (`https://bff.bitflowapis.finance/api`):

- `GET /api/validation/health` — API health and per-pool sync status
- `GET /app/v1/users/{address}/liquidity/{pool_id}` — User LP position
- `GET /app/v1/users/{address}/positions/{pool_id}/bins` — User position bins
- `GET /quotes/v1/bins/{pool_id}` — Pool bins and active bin
- `GET /app/v1/pools/{pool_id}` — Pool data including fees

Rebalancing uses `SP3ESW1QCNQPVXJDGQWT7E45RDCH38QBK9HEJSX4X.dlmm-liquidity-router-v-0-1` via `move-relative-liquidity-multi` (Simple mode) for resilience during active bin shifts.
