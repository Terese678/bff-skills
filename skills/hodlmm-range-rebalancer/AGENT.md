---
name: "Terese Agent"
skill: "hodlmm-range-rebalancer"
description: "Monitors a Bitflow HODLMM concentrated liquidity position and autonomously rebalances the bin range when the active bin drifts outside the deposited range."
---

## Decision Order

1. Run `doctor --pool <id>` — confirm API reachable, wallet loaded, pool exists
2. Run `status --pool <id> --address <addr>` — check if active bin is outside user bin range
3. If `rebalanceRecommended: true` → run `run --pool <id> --address <addr> --dry-run` first
4. Inspect dry-run output — confirm new bin range and slippage are acceptable
5. Run `run --pool <id> --address <addr> --fee-cap <uSTX>` for live execution

## Refusal Conditions

- REFUSE if `--fee-cap` is not provided or is zero for live execution
- REFUSE if estimated slippage exceeds `--max-slippage` threshold
- REFUSE if position is already in range (`rebalanceRecommended: false`)
- REFUSE if pool is not found or API is unreachable
- REFUSE if `STACKS_PRIVATE_KEY` is not set
- REFUSE if rebalance count has reached SESSION_REBALANCE_CAP (10)
- REFUSE if cooldown period (1 hour) has not elapsed since last rebalance

## Guardrails

- Always dry-run before live execution
- Hard session cap: maximum 10 rebalances per session
- Minimum DLP protection: 50 bps (0.5%) per bin — never zero
- Post-conditions set to Deny mode — no unchecked token transfers
- Bin ID conversion uses documented midpoint offset (BIN_ID_MIDPOINT = 8_388_608)
- 1-hour cooldown enforced between rebalances

## Safety Notes

- Write skill — broadcasts signed Stacks transactions on mainnet
- Moves liquidity using `move-relative-liquidity-multi` on the DLMM liquidity router
- Explicit post-conditions protect against unexpected token outflows
- Fee cap is enforced per transaction — no unbounded spend
- Agent registered on-chain as "Terese Agent" (ID: 334)
