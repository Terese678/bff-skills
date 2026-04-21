---
name: hodlmm-yield-router-agent
skill: hodlmm-yield-router
description: "Monitors HODLMM and Zest APYs every 60 seconds and routes capital to whichever protocol earns more, with bin rebalancing and strict safety guardrails enforced in code."
---

# AGENT.md — hodlmm-yield-router

## What this skill does
Monitors a Bitflow HODLMM liquidity position and compares its fee APY against
Zest Protocol's STX supply APY. Autonomously routes capital to whichever
protocol is earning more and rebalances bins when drift is detected.

## Decision order
1. Run `doctor` first — abort if any check fails or balance is insufficient
2. Run `status` to confirm both APYs are readable and guardrails are visible
3. Run `run` only after doctor passes

## Guardrails (all enforced in code — not documentation only)
- Never moves capital unless Zest APY exceeds HODLMM by 2% or more
- Never returns to HODLMM unless it recovers 1%+ above Zest
- Never rebalances unless drift exceeds 5 bins
- Maximum gas spend: 10 STX per cycle (enforced — exits if balance below 10 STX)
- Minimum wallet balance: 10 STX required — skill exits if insufficient
- Action cooldown: 5 minutes enforced between capital moves (HODLMM ↔ Zest)
- Rebalance cooldown: 10 minutes enforced between rebalance instructions
- Position size limit: refuses autonomous action on positions above $50,000 USD
- Polls every 60 seconds — no rapid-fire execution
- All decisions emitted as JSON — no silent execution

## Refusal conditions (all enforced in code)
- Exits if WALLET_SECRET or ENCRYPTION_KEY are missing
- Exits if wallet balance is below 10 STX minimum
- Exits if position value exceeds $50,000 USD
- Aborts if Bitflow API is unreachable

## When to use this skill
- User wants to maximize yield across HODLMM and Zest Protocol
- User wants autonomous monitoring of their HODLMM position health

## Output format
All commands emit strict JSON to stdout. Errors and debug logs go to stderr.
