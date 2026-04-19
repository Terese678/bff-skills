---
name: hodlmm-yield-router-agent
skill: hodlmm-yield-router
description: "Monitors HODLMM and Zest APYs every 60 seconds and routes capital to whichever protocol earns more, with bin rebalancing and strict safety guardrails."
---

# AGENT.md ΓÇö hodlmm-yield-router

## What this skill does
Monitors a Bitflow HODLMM liquidity position and compares its fee APY against
Zest Protocol's STX supply APY. Autonomously routes capital to whichever
protocol is earning more and rebalances bins when drift is detected.

## Decision order
1. Run `doctor` first ΓÇö abort if any check fails
2. Run `status` to confirm both APYs are readable
3. Run `run` only after doctor passes

## Guardrails
- Never moves capital unless Zest APY exceeds HODLMM by 2% or more
- Never returns to HODLMM unless it recovers 1%+ above Zest
- Never rebalances unless drift exceeds 5 bins
- Maximum gas spend: 10 STX per cycle
- Polls every 60 seconds ΓÇö no rapid-fire execution
- All decisions emitted as JSON instructions ΓÇö no silent execution
- Falls back to conservative 4.5% APY estimate if Zest API fails

## Refusal conditions
- Abort if WALLET_SECRET or ENCRYPTION_KEY are missing
- Abort if wallet balance is insufficient to cover gas
- Abort if Bitflow API is unreachable

## When to use this skill
- User wants to maximize yield across HODLMM and Zest Protocol
- User wants autonomous monitoring of their HODLMM position health

## Output format
All commands emit strict JSON to stdout. Errors and debug logs go to stderr.
