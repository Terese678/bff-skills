---
name: hodlmm-lp-dashboard
description: "Personal LP dashboard for active Bitflow HODLMM positions. Answers am I earning right now with range status, token composition, APR breakdown, and hold/watch/rebalance recommendation."
metadata:
  author: "ter_chimbiv"
  author-agent: "Merged Vale"
  user-invocable: "false"
  arguments: "doctor | my-position | earnings | keeper-status"
  entry: "hodlmm-lp-dashboard/hodlmm-lp-dashboard.ts"
  requires: "wallet, signing, settings"
  tags: "defi, read-only, mainnet-only, l2"
---

# HODLMM LP Dashboard

> **Note:** This skill is for LPs already IN a position. For pre-entry volatility risk assessment, see `hodlmm-risk`.

## What It Does

Monitors your active HODLMM concentrated liquidity position on Bitflow in real time. Answers the one question every LP has after opening a position: **"Am I still earning right now?"**

HODLMM concentrates liquidity in discrete price bins. When price drifts outside your range, your position earns zero fees silently — no alert, no notification. This skill detects that immediately and surfaces a clear recommendation.

## Why This Skill Exists — First-Hand Discovery

On March 28 2026, the author opened a live STX/USDCx DLMM Spot position on beta.bitflow.finance. Within hours, the position went out of range:

- **Position converted entirely to: 5.0007 STX / 0.00 USDCx**
- **Fees earning: 0%**
- **Pool was generating: $23.09K in fees on $25.23M 24h volume**
- **Out-of-range LPs received: nothing — silently**

The pool APY showed 3933% — but only in-range LPs capture it. This skill was built to surface that gap instantly.

## Commands

### `doctor`
Checks Bitflow API connectivity.
```bash
bun run hodlmm-lp-dashboard/hodlmm-lp-dashboard.ts doctor
```

### `my-position`
Full dashboard — range status, token composition, APR, recommendation.
```bash
bun run hodlmm-lp-dashboard/hodlmm-lp-dashboard.ts my-position \
  --address SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K \
  --pool-id dlmm_1
```

### `earnings`
Quick snapshot — earning right now and at what APR?
```bash
bun run hodlmm-lp-dashboard/hodlmm-lp-dashboard.ts earnings \
  --address SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K \
  --pool-id dlmm_1
```

### `keeper-status`
Check whether Keeper automation is active on a pool.
```bash
bun run hodlmm-lp-dashboard/hodlmm-lp-dashboard.ts keeper-status --pool-id dlmm_1
```

## Output Examples

**In range:**
```json
{
  "position": { "inRange": true, "binsFromNearestEdge": 8 },
  "composition": { "STXPct": 48.2, "USDCxPct": 51.8 },
  "yield": { "currentlyEarning": true, "feeAprEstimate": "27.4%" },
  "action": "hold",
  "actionReason": "Position healthy — earning ~27.4% APR."
}
```

**Out of range (real observed state):**
```json
{
  "position": { "inRange": false },
  "composition": { "STXPct": 100, "USDCxPct": 0, "note": "All STX — price below range" },
  "yield": { "currentlyEarning": false, "feeAprEstimate": "0%" },
  "action": "rebalance",
  "actionReason": "Earning 0% fees. Pool generating $23.09K daily — you are capturing none of it."
}
```

## On-Chain Proof

Built and tested against a real live position — not theoretical:

- **STX Address:** `SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K`
- **Pool:** STX/USDCx DLMM — Spot strategy, opened March 28 2026
- **Explorer:** https://explorer.stacks.co/address/SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K
- **Author Agent:** Merged Vale — AIBTC Agent #114, Genesis Level 2
- **Agent Profile:** https://aibtc.com/agents/bc1qud2unr2t4y402xwpffejd2uu4htxdvqjzryrnj
- **HODLMM integration:** Yes ✅ — eligible for +$1,000 bonus pool
