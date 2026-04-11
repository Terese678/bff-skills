skill: "hodlmm-stop-loss"
version: "1.0.0"
description: "Sentinel agent that continuously monitors a Bitflow HODLMM concentrated liquidity position across multiple health dimensions — value erosion, out-of-range duration, and fee-drag ratio — and autonomously removes a configurable percentage of liquidity when a stop-loss threshold is breached. Designed to protect capital during adverse price movements without requiring manual intervention."
author: "Terese678"
author-agent: "Merged Vale"
user-invocable: "false"
entry: "skills/hodlmm-stop-loss/hodlmm-stop-loss.ts"
tags: "defi, write, hodlmm, risk-management, autonomous"
requires: "STACKS_PRIVATE_KEY, STACKS_ADDRESS"

metadata:
  name: "HODLMM Stop-Loss Sentinel"
  category: "DeFi / Risk Management"
  hodlmm-integration: "true"
  skill-type: "write"
  chain: "stacks"
  network: "mainnet"

commands:
  doctor:
    description: "Validates environment variables, wallet connectivity, Bitflow API reachability, and pool existence. Outputs a JSON health report with actionable error messages."
    usage: "bun hodlmm-stop-loss.ts doctor --pool <pool-id>"
    output: "{ status, checks: { env, wallet, api, pool }, warnings }"

  status:
    description: "Fetches current position snapshot — active bin, deposited range, USD value, out-of-range duration estimate, and current stop-loss threshold proximity. Does not write to chain."
    usage: "bun hodlmm-stop-loss.ts status --pool <pool-id> --threshold <0-100>"
    output: "{ pool, position, value_usd, threshold_pct, distance_to_trigger_pct, health_score, recommendation }"

  run:
    description: "Starts the sentinel loop. Polls position health every --interval seconds. When value drops below --threshold percent of peak observed value, broadcasts a remove-liquidity transaction for --exit-pct percent of total shares. Enforces cooldown between triggers to prevent repeated partial exits."
    usage: "bun hodlmm-stop-loss.ts run --pool <pool-id> --threshold <pct> --exit-pct <pct> --fee-cap <stx> [--interval <seconds>] [--dry-run]"
    output: "Streaming JSON events: { event, timestamp, data }"

parameters:
  --pool: "HODLMM pool ID (e.g. dlmm_3)"
  --threshold: "Stop-loss trigger: percentage drop from peak value (e.g. 20 = trigger at 20% drawdown)"
  --exit-pct: "Percentage of total LP shares to remove when triggered (1-100)"
  --fee-cap: "Maximum STX fee per transaction. Required. Agent refuses to act if fee exceeds cap."
  --interval: "Poll interval in seconds (default: 60, min: 30)"
  --dry-run: "Simulate sentinel loop without broadcasting transactions"

safety:
  cooldown-blocks: 10
  max-triggers-per-session: 3
  min-exit-pct: 1
  max-exit-pct: 100
  fee-cap-required: "true"
  post-condition-mode: "Deny"
  refusal-conditions:
    - "STACKS_PRIVATE_KEY not set"
    - "--fee-cap not provided"
    - "Estimated fee exceeds --fee-cap"
    - "Pool not found or inactive"
    - "Position has zero shares"
    - "Trigger fired within cooldown window"
    - "max-triggers-per-session reached"
    - "API returns stale data (>5 min old)"

output-contract:
  format: "strict JSON to stdout"
  errors: "{ error: string, code: string }"
  events:
    - "sentinel_started"
    - "position_snapshot"
    - "threshold_breached"
    - "transaction_prepared"
    - "transaction_confirmed"
    - "cooldown_active"
    - "session_cap_reached"
    - "sentinel_stopped"

proof:
  agent-registration: "https://explorer.hiro.so/txid/YOUR_TX_HERE?chain=mainnet"
  dry-run-output: "available on request"
