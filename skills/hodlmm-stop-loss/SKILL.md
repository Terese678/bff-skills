---
name: hodlmm-stop-loss
description: "Autonomously guards a Bitflow HODLMM concentrated liquidity position by tracking impermanent loss in real time and executing a partial liquidity withdrawal when IL breaches a user-defined threshold for two consecutive cycles."
metadata:
  author: "Terese678"
  author-agent: "Merged Vale"
  user-invocable: "false"
  entry: "hodlmm-stop-loss/hodlmm-stop-loss.ts"
  requires: "STACKS_PRIVATE_KEY, STACKS_ADDRESS"
  tags: "defi, write, hodlmm, risk-management, mainnet-only"
---

# HODLMM Stop-Loss

A capital-protection skill for Bitflow HODLMM liquidity providers. Computes impermanent loss in real time and autonomously withdraws liquidity when IL breaches your threshold for two consecutive cycles.

## What it does

Monitors a Bitflow HODLMM concentrated liquidity position. Captures an entry snapshot at session start and computes IL each cycle by comparing current LP value against a HODL baseline. When IL exceeds the threshold for 2 consecutive cycles, executes `withdraw-liquidity-same-multi` on the DLMM liquidity router to remove a configurable percentage of shares across all user bins.

## Why agents need it

Impermanent loss is the primary risk for HODLMM liquidity providers. Without automated protection, a position can lose significant value before a human notices. This skill closes that gap by acting autonomously the moment IL becomes dangerous, protecting capital before losses compound.

## Commands

- `doctor` - Validates Bitflow API, Hiro API, wallet balance, and dependencies. Outputs JSON health report.
- `status` - Fetches live position data including shares, bin range, in-range status, and current USD value.
- `run` - Enters monitoring loop. Executes withdrawal when IL threshold is breached for 2 consecutive cycles.

### Flags for `run`
- `--pool <id>` Pool ID to monitor (e.g. dlmm_3)
- `--wallet <address>` STX address
- `--il-threshold <n>` IL% that triggers exit (default: 5)
- `--exit-pct <n>` % of shares to remove per trigger (default: 50)
- `--fee-cap <stx>` Max STX fee per tx (REQUIRED)
- `--interval <sec>` Polling interval in seconds (default: 60)
- `--max-exits <n>` Max exit transactions per session (default: 3, hard cap: 10)
- `--dry-run` Simulate without broadcasting

## Output contract

All commands output JSON to stdout.

```json
{ "event": "threshold_pending_confirmation", "cycle": 2, "il_pct": 7.12, "confirmation_streak": 1, "confirmation_required": 2, "executing": false }
{ "event": "exit_executed", "cycle": 3, "il_pct": 7.45, "confirmation_streak": 2, "executing": true, "txid": "0x..." }
{ "error": "fee-cap is required for live execution" }
```

## Safety notes

- `--fee-cap` required — refuses to start without explicit spend limit
- 2-cycle confirmation window — IL must breach threshold twice consecutively before any exit
- 10-block cooldown between exits (~100 min on Stacks mainnet)
- Hard cap of 10 exits per session
- `--dry-run` mode for full simulation without on-chain writes
- Refuses if wallet STX balance < 0.05 STX
- Refuses if `--exit-pct` > 100 or `--max-exits` > 10

## On-chain proof

Transaction: https://explorer.hiro.so/txid/0xb18000ce6223b366ac76814a09d714aef7758d706587af39b0a4b1fdb7205519?chain=mainnet