---
name: hodlmm-range-rebalancer
skill: hodlmm-range-rebalancer
description: "Autonomous HODLMM LP rebalancer. Detects out-of-range positions and moves liquidity bins to re-center on the active bin using the Bitflow HODLMM API and move-relative-liquidity-multi."
---

# HODLMM Range Rebalancer — Agent Behavior

## Purpose

This agent monitors a Bitflow HODLMM concentrated liquidity position and autonomously executes a bin range rebalance when the active bin drifts outside the deposited range. An out-of-range position earns zero trading fees — this agent stops that loss before it compounds.

## Decision Order

The agent follows this exact sequence on every monitoring cycle:

1. **Check cooldown** — if last rebalance was less than 3600s ago, output `{ "status": "cooldown" }` and skip
2. **Check session cap** — if 10 rebalances have been executed this session, output `{ "error": "Session cap reached" }` and halt
3. **Fetch API health** via `GET /api/validation/health` — if unhealthy, output error and skip cycle
4. **Fetch pool bins** via `GET /quotes/v1/bins/{pool_id}` — extract `active_bin_id`
5. **Fetch user position bins** via `GET /app/v1/users/{address}/positions/{pool_id}/bins`
6. **Detect range** — if `active_bin_id` is within deposited bin range, output `{ "status": "in-range" }` and skip
7. **Compute new range** — center a range of same width on `active_bin_id` using Simple mode offsets
8. **Estimate slippage** — if estimated slippage exceeds `--max-slippage`, output error and abort
9. **Check fee cap** — if estimated fee exceeds `--fee-cap`, output error and abort
10. **Execute or simulate** — if `--dry-run`, output simulated result; otherwise broadcast `move-relative-liquidity-multi`

## Spend Limits

- `--fee-cap` (required): Maximum uSTX transaction fee. No transaction executes without this.
- `--max-slippage` (default: 1): Maximum slippage percentage. Rebalance aborted if exceeded.
- Cooldown: 3600 seconds between rebalances (hardcoded, not configurable)
- Session cap: 10 rebalances per `run` invocation (hardcoded, not configurable)

## Refusal Conditions

The agent outputs `{ "error": "..." }` and halts **without executing any transaction** if ANY of the following are true:

1. `--fee-cap` is not provided
2. Slippage estimate exceeds `--max-slippage`
3. Network is not Stacks mainnet
4. Wallet key is not loaded
5. API health check returns unhealthy
6. Pool bins endpoint returns no data
7. User has zero liquidity in pool
8. Cooldown has not elapsed since last rebalance
9. Session rebalance count has reached 10
10. `--dry-run` is active (simulation only — no broadcast)

## Operational Guardrails

- All output is strict JSON — no prose, no markdown
- Logs each cycle to stderr for operator visibility; stdout is JSON only
- Uses Simple mode (`move-relative-liquidity-multi`) not Strict mode — more resilient during fast price movement
- `PostConditionMode.Allow` on Simple mode transactions — contract handles safety
- Records last rebalance timestamp to persistent state between cycles
- Graceful shutdown on SIGINT/SIGTERM — outputs final status before exit

## Example Scenarios

**Out of range → rebalance executes:**
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

**In range → no action:**
```json
{
  "status": "in-range",
  "action": "none",
  "position": { "activeBin": 8350, "depositedRange": { "lower": 8300, "upper": 8400 } },
  "timestamp": 1712000000
}
```

**Slippage exceeded → abort:**
```json
{
  "error": "Slippage 2.4% exceeds configured max of 1%. Rebalance aborted."
}
```

**Fee cap exceeded → abort:**
```json
{
  "error": "Estimated fee 15000 uSTX exceeds fee-cap of 10000 uSTX. Rebalance aborted."
}
```
