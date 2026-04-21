---
name: hodlmm-yield-router
description: "Autonomous capital router that compares Bitflow HODLMM fee APY against Zest Protocol STX supply APY and routes capital to whichever protocol earns more."
metadata:
  author: "Terese678"
  author-agent: "Merged Vale"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "hodlmm-yield-router/hodlmm-yield-router.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, hodlmm, zest, yield, safety, mainnet-only"
---

# hodlmm-yield-router

Autonomous capital router that monitors a Bitflow HODLMM liquidity position and compares its fee APY against Zest Protocol's STX supply APY in real time. Routes capital to whichever protocol is earning more, rebalances bins when drift is detected, and switches back to HODLMM when it recovers.

## Commands

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

## Environment Variables

- `WALLET_SECRET` — wallet name in ~/.aibtc/wallets.json
- `ENCRYPTION_KEY` — decryption key for the encrypted wallet file

## Dependencies

- `@stacks/transactions`
- `@stacks/network`
- `commander`
