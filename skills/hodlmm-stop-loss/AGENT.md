---
name: "HODLMM Stop-Loss Sentinel"
skill: "hodlmm-stop-loss"
description: "Autonomous sentinel that monitors a Bitflow HODLMM position for value erosion and executes a partial or full liquidity exit when a configurable drawdown threshold is breached. Protects LP capital during adverse price movements without requiring manual intervention."
---

# Agent Behavior

## Purpose

This agent acts as a capital protection layer for Bitflow HODLMM liquidity positions. It continuously tracks position value relative to a peak high-water mark. When the value drops by a user-defined percentage, it autonomously removes a configured share of liquidity and broadcasts the transaction on-chain — then enters a cooldown period to prevent repeated triggering during volatile conditions.

## Decision Order

1. Run `doctor` to confirm environment, wallet, API, and pool are all healthy
2. Run `status` to establish baseline position value and distance to threshold
3. If all checks pass and `--dry-run` is not set, start the sentinel loop
4. On each poll cycle:
   a. Fetch current position value from Bitflow API
   b. Update high-water mark if value has increased
   c. Calculate drawdown: `(peak - current) / peak * 100`
   d. If drawdown >= threshold AND cooldown has elapsed AND session cap not reached:
      - Prepare remove-liquidity transaction for `exit-pct` of shares
      - Validate estimated fee against `--fee-cap`
      - Broadcast with PostConditionMode.Deny
      - Poll for confirmation (max 10 blocks)
      - Enter cooldown (10 blocks)
      - Increment trigger counter
   e. Emit JSON event to stdout regardless of action

## Operational Limits

| Parameter | Default | Hard Limit |
|---|---|---|
| Poll interval | 60s | min 30s |
| Max triggers per session | — | 3 |
| Cooldown after trigger | — | 10 blocks |
| Fee cap | required | user-defined |
| Exit percentage | required | 1–100% |

## Refusal Conditions

The agent will refuse to start or act if any of the following are true:

- `STACKS_PRIVATE_KEY` is not set in environment
- `--fee-cap` flag is missing
- Estimated transaction fee exceeds `--fee-cap`
- Pool ID does not exist or returns no active bins
- Position has zero LP shares
- Trigger fired within the 10-block cooldown window
- Session trigger cap (3) has been reached
- API data is stale (timestamp older than 5 minutes)
- `--threshold` is set to 0 (would trigger immediately)
- `--exit-pct` is set to 0 (no-op exit)

## Autonomy Notes

This agent executes real on-chain transactions without human approval per cycle. It is designed to be safe by default:

- **PostConditionMode.Deny** on all transactions — contract cannot take more tokens than explicitly authorized
- **High-water mark tracking** — threshold is relative to peak observed value, not entry price
- **Cooldown enforcement** — prevents cascading exits during flash volatility
- **Session cap** — stops the agent after 3 triggers so a human can review
- **Fee cap** — hard stops any transaction where the estimated fee exceeds the user's limit
- **Dry-run mode** — full sentinel simulation without any broadcast

## Output Format

All output is strict JSON to stdout. One JSON object per line.

```json
{ "event": "sentinel_started", "timestamp": "...", "data": { "pool": "dlmm_3", "threshold_pct": 20, "exit_pct": 50, "fee_cap_stx": 0.1 } }
{ "event": "position_snapshot", "timestamp": "...", "data": { "value_usd": 1.10, "peak_usd": 1.42, "drawdown_pct": 22.5, "shares": "1000000" } }
{ "event": "threshold_breached", "timestamp": "...", "data": { "drawdown_pct": 22.5, "threshold_pct": 20, "action": "remove_liquidity" } }
{ "event": "transaction_confirmed", "timestamp": "...", "data": { "txid": "0x...", "shares_removed": "500000", "fee_stx": 0.08 } }
{ "event": "cooldown_active", "timestamp": "...", "data": { "blocks_remaining": 10 } }
```

## Example Usage

```bash
# Check environment health
bun hodlmm-stop-loss.ts doctor --pool dlmm_3

# Preview position and threshold proximity
bun hodlmm-stop-loss.ts status --pool dlmm_3 --threshold 20

# Run sentinel: exit 50% of shares if value drops 20% from peak
bun hodlmm-stop-loss.ts run \
  --pool dlmm_3 \
  --threshold 20 \
  --exit-pct 50 \
  --fee-cap 0.1 \
  --interval 60

# Dry run (no transactions broadcast)
bun hodlmm-stop-loss.ts run \
  --pool dlmm_3 \
  --threshold 20 \
  --exit-pct 50 \
  --fee-cap 0.1 \
  --dry-run
```
