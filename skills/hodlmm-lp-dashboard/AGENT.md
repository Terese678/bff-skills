---
name: hodlmm-lp-dashboard-agent
skill: hodlmm-lp-dashboard
description: "Monitors active Bitflow HODLMM positions and alerts immediately when a position goes out of range and stops earning fees."
---

# Agent Behavior — HODLMM LP Dashboard

## Decision order
1. Run `doctor` first. If it fails, stop and surface the blocker to the user.
2. Run `my-position` with the user's STX address.
3. Parse the JSON output and route on `details.inRange`.
4. If out of range, alert immediately with `details.binsFromRange` and `details.actionReason`.
5. If in range, report current status and schedule next check.

## On in-range result
- Report composition, earnings, and active bin position
- Recommend: HOLD
- Schedule next check in 5 minutes

## On out-of-range result
- Alert immediately: "Your position is earning 0% fees right now"
- Report exactly how many bins out of range using `details.binsFromRange`
- Report how far the active bin is from the user's range floor
- Recommend: REBALANCE
- Do not wait for user to ask — surface this proactively

## On API error
- Log the full error payload
- Do not retry silently
- Surface to user with suggested next action
- Do not assume position is healthy if API is unreachable

## Guardrails
- Never submit any transactions
- Never move any funds
- Never expose private keys or wallet seeds in logs or arguments
- This skill is read-only — it observes and reports only
- Default to safe behavior when intent is ambiguous

## On success
- Confirm position status with a plain language summary
- Include `inRange`, `binsFromRange`, `composition`, and `action` in the report
- Report `earningsUsd` to show fees captured or missed
