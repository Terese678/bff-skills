---
name: hodlmm-range-rebalancer-agent
skill: hodlmm-range-rebalancer
description: "Autonomous HODLMM LP rebalancer. Detects out-of-range positions and moves liquidity bins to re-center on the active bin using the Bitflow HODLMM API and move-relative-liquidity-multi."
---

# Agent Behavior — HODLMM Range Rebalancer

## Decision order
1. Run `doctor` first. If any check fails, stop and surface the blocker to the operator.
2. Run `status` to confirm position state before any write action.
3. If out of range and all safety limits pass, execute `run`.
4. Parse JSON output on every cycle and route on `status` field.
5. On `"status": "rebalanced"` — confirm tx hash and log rebalance count.
6. On `"status": "in-range"` — wait for next poll cycle, no action.
7. On `"status": "cooldown"` — wait out remaining cooldown, no action.
8. On `"error"` — log payload, surface to operator, do not retry silently.

## Guardrails
- Never proceed past a `doctor` failure without explicit operator confirmation.
- Never expose `STACKS_PRIVATE_KEY` in args, logs, or output.
- Always require `--fee-cap` before executing any write operation.
- Always run `--dry-run` first when starting a new session.
- Default to read-only (`status`) when intent is ambiguous.
- Never exceed the session rebalance cap of 10 — halt and report.
- Never rebalance if estimated slippage exceeds `--max-slippage`.
- Never rebalance if cooldown has not elapsed since last rebalance.

## Spend limits
- `--fee-cap` (required): Maximum uSTX transaction fee. No transaction executes without this.
- `--max-slippage` (default: 1): Maximum slippage percentage. Rebalance aborted if exceeded.
- Cooldown: 3600 seconds between rebalances (hardcoded).
- Session cap: 10 rebalances per `run` invocation (hardcoded).

## Refusal conditions
The agent outputs `{ "error": "..." }` and halts without executing any transaction if ANY of the following are true:

1. `--fee-cap` is not provided
2. Slippage estimate exceeds `--max-slippage`
3. Network is not Stacks mainnet
4. Wallet key (`STACKS_PRIVATE_KEY`) is not loaded
5. API health check returns unhealthy
6. Pool bins endpoint returns no data
7. User has zero liquidity in pool
8. Cooldown has not elapsed since last rebalance
9. Session rebalance count has reached 10
10. `--dry-run` is active (simulation only — no broadcast)

## On error
- Log the full error payload to operator
- Do not retry silently
- Surface descriptive error message with suggested next action
- If API is unreachable, wait one poll cycle before retrying

## On success
- Confirm tx hash from broadcast response
- Log rebalance count and new bin range
- Update last rebalance timestamp in session state
- Report completion with summary JSON to stdout

## Example scenarios

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
