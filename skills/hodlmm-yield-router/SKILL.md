---
name: hodlmm-yield-router
description: "Autonomous capital router that compares Bitflow HODLMM fee APY against Zest Protocol STX supply APY and routes capital to whichever protocol earns more."
metadata:
  author: "Terese678"
  author-agent: "HODLMM Yield Router"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "hodlmm-yield-router/hodlmm-yield-router.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, hodlmm, zest, yield, mainnet-only"
---

# hodlmm-yield-router

## What it does

Monitors a Bitflow HODLMM liquidity position and compares its fee APY against Zest Protocol STX supply APY in real time. When Zest APY exceeds HODLMM by 2% or more, emits a Zest deposit instruction and switches to Zest mode. When HODLMM recovers above Zest by 1%+, emits a re-entry instruction and switches back. Rebalances bins automatically when drift exceeds 5 bins from position center.

## Why agents need it

HODLMM liquidity providers lose yield when their position drifts out of range or when lending rates outperform LP fees. Without automation, capital sits idle or underperforms. This skill closes that gap by continuously comparing protocols and routing capital to the highest-yielding option — acting as a fully autonomous capital allocator that earns fees or interest continuously without human intervention.

## Commands

- `doctor` - Validates Bitflow API, Zest API, Hiro API, wallet balance, and dependencies. Outputs JSON health report.
- `status` - Fetches live position data, current HODLMM APY, current Zest APY, and routing recommendation.
- `run` - Enters monitoring loop. Compares APYs each cycle and emits routing instructions when thresholds are breached.

### doctor
bun run hodlmm-yield-router.ts doctor

### status
bun run hodlmm-yield-router.ts status

### run
bun run hodlmm-yield-router.ts run

## Routing Logic

| Condition | Action |
|---|---|
| In range + HODLMM APY competitive | Stay, monitor |
| Drift > 5 bins | Emit rebalance instruction |
| Zest APY exceeds HODLMM by 2%+ | Emit Zest deposit instruction, switch mode |
| In Zest mode + HODLMM recovers 1%+ above Zest | Emit re-entry instruction, switch mode |

## Output contract

All commands output JSON to stdout.

```json
{ "event": "monitoring", "hodlmm_apy": 8.2, "zest_apy": 6.1, "mode": "hodlmm", "action": "stay" }
{ "event": "routing_instruction", "from": "hodlmm", "to": "zest", "reason": "zest_apy_exceeds_hodlmm_by_2pct", "zest_apy": 10.5, "hodlmm_apy": 7.8 }
{ "event": "rebalance_instruction", "drift_bins": 7, "action": "move_liquidity" }
{ "error": "WALLET_SECRET is required for live execution" }
```

## Safety notes

- Never moves capital silently — emits instructions only, execution requires explicit confirmation
- Maximum gas spend enforced at 10 STX per cycle
- Never routes to Zest unless APY exceeds HODLMM by 2%+ threshold
- Never returns to HODLMM unless it recovers 1%+ above Zest
- Falls back to conservative 4.5% APY estimate if Zest API is unreachable
- Mainnet only
- Requires WALLET_SECRET and ENCRYPTION_KEY environment variables

## Environment Variables

- `WALLET_SECRET` - wallet name in ~/.aibtc/wallets.json
- `ENCRYPTION_KEY` - decryption key for the encrypted wallet file

## Dependencies

- `@stacks/transactions`
- `@stacks/network`
- `commander`