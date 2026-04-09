---
name: dlmm-position-analyst
description: "Fetches a wallet's full DLMM position history on Bitflow, analyzes fee earnings, in-range time, and price patterns using Claude, then autonomously repositions out-of-range liquidity to the optimal bin range."
metadata:
  author: "Terese678"
  author-agent: "Merged Vale"
  user-invocable: "false"
  arguments: "doctor | status | analyze | reposition"
  entry: "dlmm-position-analyst/dlmm-position-analyst.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, hodlmm, bitflow, dlmm, analytics, reposition"
---

# DLMM Position Analyst

A Claude-powered DeFi analytics agent that reads your complete DLMM position history on Bitflow, identifies patterns in price movement and fee earnings, explains what happened in plain English, and autonomously repositions out-of-range liquidity to the optimal range based on historical data.

## What It Does

- Pulls all DLMM add/remove liquidity transactions for a given wallet from the Stacks API
- Calculates per-position stats: time in range, fees earned, impermanent loss, net P&L
- Feeds the full history to Claude for pattern analysis and plain-English explanation
- Identifies the best-performing price ranges historically
- If a position is currently out of range: removes it and redeploys at the optimal range around current price
- Outputs a full recap: what worked, what didn't, and what the agent did

## Why DLMM > Standard AMM

DLMM (Dynamic Liquidity Market Maker) concentrates liquidity in discrete price bins where trading actually occurs — rather than spreading it thin across a full curve where most of it sits idle. This makes capital significantly more efficient. But it requires active management: when price moves outside your bins, you earn zero fees. This skill automates that management.

## Commands

```bash
# Check environment and wallet connectivity
bun run dlmm-position-analyst.ts doctor

# Show current position status (in range / out of range)
bun run dlmm-position-analyst.ts status

# Full Claude-powered analysis of position history
bun run dlmm-position-analyst.ts analyze

# Analyze + autonomously reposition if out of range
bun run dlmm-position-analyst.ts reposition
```

## Output contract

```json
{
  "status": "success | error | blocked",
  "action": "doctor | status | analyze | reposition",
  "data": {},
  "error": null
}
```

## Output Format

```json
{
  "status": "success",
  "action": "reposition",
  "data": {
    "wallet": "SP2A37...",
    "pool": "STX/USDCx",
    "current_price": 0.228,
    "position_status": "out_of_range",
    "previous_range": "0.234-0.254",
    "new_range": "0.221-0.235",
    "fees_earned_total": "$0.00",
    "analysis": "Your position was out of range for 4 days...",
    "tx_id": "0x..."
  },
  "error": null
}
```

## Example Usage

```bash
# Full autonomous run
bun run dlmm-position-analyst.ts reposition

# Just read the analysis, no write action
bun run dlmm-position-analyst.ts analyze
```

## Safety

- Never repositions without first verifying current position is out of range
- Slippage capped at 4% (matches Bitflow default)
- Spend limit: never moves more than the existing position value
- Requires explicit `reposition` command — analyze alone never writes
- All actions logged with transaction ID proof
