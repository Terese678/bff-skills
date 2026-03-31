---
name: hodlmm-lp-dashboard
description: "Personal LP dashboard for active Bitflow HODLMM positions. Answers am I earning right now with range status, bin distance, token composition, and hold/watch/rebalance recommendation."
metadata:
  author: "ter_chimbiv"
  author-agent: "Merged Vale"
  user-invocable: "false"
  arguments: "doctor | my-position | pool-status"
  entry: "hodlmm-lp-dashboard/hodlmm-lp-dashboard.ts"
  requires: "wallet, signing, settings"
  tags: "defi, read-only, mainnet-only, l2"
---

# HODLMM LP Dashboard

> **Note:** This skill is for LPs already IN a position. For pre-entry volatility risk assessment, see `hodlmm-risk`.

## What it does

Monitors your active HODLMM concentrated liquidity position on Bitflow in real time. Answers the one question every LP has after opening a position: **"Am I still earning right now?"**

HODLMM concentrates liquidity in discrete price bins. When price drifts outside your range, your position earns zero fees silently — no alert, no notification from Bitflow. This skill detects that immediately, calculates exactly how many bins out of range you are, and surfaces a clear recommendation.

## Why agents need it

Bitflow sends no alerts when a position goes out of range. On March 28 2026, the author's live STX/USDCx position went out of range silently — converting entirely to 5.0007 STX / 0.00 USDCx. The pool was generating $23.09K in daily fees on $25.23M volume. Out-of-range LPs received nothing. No notification. No warning. An autonomous agent without this skill would hold a dead position indefinitely, bleeding opportunity while the pool earns for everyone else. This skill closes that gap.

## Safety notes
- This skill is read-only. It never submits transactions.
- It never moves funds of any kind.
- Mainnet only — HODLMM positions do not exist on testnet.
- No irreversible actions. Safe to run repeatedly at any interval.

## Commands

### `doctor`
Checks Bitflow API connectivity.
```bash
bun run hodlmm-lp-dashboard/hodlmm-lp-dashboard.ts doctor
```

### `my-position`
Full dashboard — range status, bin distance, token composition, recommendation.
```bash
bun run hodlmm-lp-dashboard/hodlmm-lp-dashboard.ts my-position \
  --address SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K
```

### `pool-status`
Current pool active bin and total bin count.
```bash
bun run hodlmm-lp-dashboard/hodlmm-lp-dashboard.ts pool-status
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{ "result": "success", "details": { "inRange": false, "activeBin": 279, "userBinRange": { "min": 340, "max": 421 }, "binsFromRange": 61, "composition": "100% STX — price is below your range", "earningsUsd": 0, "action": "rebalance", "actionReason": "Out of range by 61 bins. Active bin 279 is below your range floor of 340. Earning 0% fees." } }
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Why This Skill Exists — First-Hand Discovery

On March 28 2026, the author opened a live STX/USDCx DLMM Spot position on beta.bitflow.finance. Within hours, the position went out of range:

- **Position converted entirely to: 5.0007 STX / 0.00 USDCx**
- **Fees earning: 0%**
- **Pool was generating: $23.09K in fees on $25.23M 24h volume**
- **Out-of-range LPs received: nothing — silently**
- **Distance out of range: 61 bins below the active bin**

The pool APY showed 3933% — but only in-range LPs capture it. This skill was built to surface that gap instantly.

## On-Chain Proof

Built and tested against a real live position — not theoretical:

- **STX Address:** `SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K`
- **Pool:** STX/USDCx DLMM — Spot strategy, opened March 28 2026
- **Active bin at time of observation:** 279
- **User bin range:** 340–421 (61 bins out of range)
- **Explorer:** https://explorer.stacks.co/address/SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K
- **Author Agent:** Merged Vale — AIBTC Agent #114, Genesis Level 2
- **Agent Profile:** https://aibtc.com/agents/bc1qud2unr2t4y402xwpffejd2uu4htxdvqjzryrnj
- **HODLMM integration:** Yes ✅
