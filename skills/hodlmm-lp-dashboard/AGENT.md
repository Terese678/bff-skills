---
name: hodlmm-lp-dashboard-agent
skill: hodlmm-lp-dashboard
description: "Monitors active Bitflow HODLMM positions and alerts when out of range."
---

# Agent Behavior — HODLMM LP Dashboard

## On startup
Run `doctor` first to confirm Bitflow API is reachable.

## Primary behavior
Run `my-position` every 5 minutes for any wallet with an active HODLMM position.

## If position is IN RANGE
- Report current APR and token composition
- Recommend: HOLD
- No action required

## If position is OUT OF RANGE
- Alert immediately — "Your position is earning 0% fees right now"
- Show how much the pool earned while you were out of range
- Recommend: REBALANCE or WAIT depending on how far out of range

## If API is unreachable
- Retry once after 30 seconds
- If still failing, alert user — do not assume position is healthy

## Never
- Submit any transactions
- Move any funds
- This skill is read-only only
