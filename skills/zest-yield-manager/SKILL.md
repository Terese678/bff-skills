---
name: zest-yield-manager
description: Autonomous sBTC yield management on Zest Protocol — supply, withdraw, claim rewards, and monitor positions with safety controls.
author: secret-mars
author_agent: Secret Mars
user-invocable: true
arguments: doctor | run | install-packs
entry: zest-yield-manager/zest-yield-manager.ts
requires: [wallet, signing, settings]
tags: [defi, write, mainnet-only, requires-funds, l2]
---

# Zest Yield Manager

## What it does

Manages sBTC lending positions on Zest Protocol (Stacks L2). Supplies idle sBTC to earn yield from borrowers, monitors position health, claims wSTX incentive rewards, and withdraws when needed. All operations go through Zest's audited pool-borrow contracts with Pyth oracle price feeds.

## Why agents need it

Any agent holding sBTC has idle capital losing value to opportunity cost. This skill automates the supply/withdraw/claim cycle so agents earn yield without manual intervention. It handles the Pyth oracle fee, post-conditions, and borrow-helper versioning that trip up manual callers.

## Safety notes

- **Writes to chain.** Supply and withdraw submit Stacks transactions (cost ~50k uSTX gas + ~2 uSTX Pyth fee).
- **Moves funds.** sBTC leaves the wallet when supplied; returns on withdraw. Funds are in Zest's audited lending pool, not a custodial address.
- **Mainnet only.** Zest Protocol is deployed on Stacks mainnet.
- **Supply-only.** v1 does not implement borrowing. Future versions may add borrow support with explicit opt-in.
- **Spend limit enforced.** Default max supply per call: 500,000 sats. Override with `--max-supply-sats`.
- **Withdrawal always allowed.** No confirmation gate on withdrawing your own funds.

## Commands

### doctor
Checks wallet STX balance (for gas), sBTC balance, Zest contract availability, and Pyth oracle status. Safe to run anytime — read-only.
```bash
bun run skills/zest-yield-manager/zest-yield-manager.ts doctor
```

### run
Core execution. Accepts sub-commands:

**Check position (default, read-only):**
```bash
bun run skills/zest-yield-manager/zest-yield-manager.ts run --action=status
```

**Supply sBTC to earn yield:**
```bash
bun run skills/zest-yield-manager/zest-yield-manager.ts run --action=supply --amount=50000
```

**Withdraw sBTC from pool:**
```bash
bun run skills/zest-yield-manager/zest-yield-manager.ts run --action=withdraw --amount=50000
```

**Claim wSTX incentive rewards:**
```bash
bun run skills/zest-yield-manager/zest-yield-manager.ts run --action=claim
```

### install-packs
Installs required dependencies: `@stacks/transactions`, `@stacks/network`.
```bash
bun run skills/zest-yield-manager/zest-yield-manager.ts install-packs --pack all
```

## Output contract
All outputs are JSON to stdout.

```json
{
  "status": "success | error | blocked",
  "action": "what the agent should do next",
  "data": {
    "position": {
      "supplied_sats": 0,
      "borrowed_sats": 0,
      "rewards_pending_ustx": 0,
      "asset": "sBTC"
    },
    "txid": null,
    "balances": {
      "sbtc_sats": 0,
      "stx_ustx": 0
    }
  },
  "error": null
}
```

## Known constraints

- Requires STX for gas (~50,000 uSTX per transaction). Doctor command checks this.
- Pyth oracle must be reachable (Zest uses it for price feeds). Rare outages possible.
- Zest uses borrow-helper-v2-1-7 on mainnet. Older versions will fail.
- Withdrawal may fail if pool utilization is 100% (all supplied funds are borrowed). Retry later.
- wSTX reward claims return 0 if no rewards have accrued since last claim.
