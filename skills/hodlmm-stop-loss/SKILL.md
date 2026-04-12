---
name: "hodlmm-stop-loss"
version: "1.0.0"
description: "Autonomously guards a Bitflow HODLMM concentrated liquidity position by tracking impermanent loss (IL) in real time and executing a partial liquidity withdrawal via withdraw-liquidity-same-multi when IL breaches a user-defined threshold for two consecutive cycles — protecting capital before losses compound."
author: "Terese678"
author-agent: "Merged Vale"
user-invocable: "false"
entry: "skills/hodlmm-stop-loss/hodlmm-stop-loss.ts"
tags: "defi, write, hodlmm, risk-management, impermanent-loss"
requires: "STACKS_PRIVATE_KEY, STACKS_ADDRESS"

metadata:
  category: "DeFi / Risk Management"
  hodlmm-integration: "true"
  skill-type: "write"
  network: "mainnet"
  protocols: "Bitflow HODLMM"
  router: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1"
  function: "withdraw-liquidity-same-multi"
  trigger: "Impermanent loss exceeds --il-threshold for 2 consecutive cycles"
  action: "Remove configurable percentage of liquidity shares per bin"
  safety: "2-cycle confirmation window, 10-block cooldown (~100 min), session exit cap, fee-cap required"
  proof: "Agent Merged Vale registered at https://aibtc.com/agents — wallet SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K — registration tx: https://explorer.hiro.so/txid/0xb1...05519?chain=mainnet"

commands:
  doctor:
    description: "Validates Bitflow API, Hiro API, wallet balance, and @stacks/transactions availability."
    output: "JSON health report with per-check ok/detail"

  status:
    description: "Fetches live position data — shares, bin range, in-range status, current USD value. Reports IL threshold for reference. Drawdown tracking requires a live run session."
    flags:
      - "--pool <id>          Pool ID (e.g. dlmm_3)"
      - "--wallet <address>   STX address"
      - "--il-threshold <n>   IL% for reference (default: 5)"
    output: "JSON position snapshot"

  run:
    description: "Enters a monitoring loop. Captures entry snapshot at session start. Each cycle computes IL vs entry baseline. If IL >= threshold for 2 consecutive cycles, executes withdraw-liquidity-same-multi for exit-pct of shares across all user bins. Halts after max-exits."
    flags:
      - "--pool <id>          Pool ID to monitor"
      - "--wallet <address>   STX address"
      - "--password <pass>    Wallet password (required for live execution)"
      - "--il-threshold <n>   IL% that triggers exit (default: 5)"
      - "--exit-pct <n>       % of shares to remove per trigger (default: 50)"
      - "--fee-cap <stx>      Max STX fee per tx (REQUIRED)"
      - "--interval <sec>     Polling interval in seconds (default: 60)"
      - "--max-exits <n>      Max exit transactions per session (default: 3, hard cap: 10)"
      - "--dry-run            Simulate without broadcasting"
    output: "Streaming JSON events"

examples:
  - "bun hodlmm-stop-loss.ts doctor --wallet SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K"
  - "bun hodlmm-stop-loss.ts status --pool dlmm_3 --wallet SP2A37MQTATZTY386B8NQR6RZA15GF0BQNFVZP79K"
  - "STACKS_PRIVATE_KEY=<key> bun hodlmm-stop-loss.ts run --pool dlmm_3 --wallet SP2A37... --il-threshold 5 --exit-pct 50 --fee-cap 0.1 --dry-run"
  - "STACKS_PRIVATE_KEY=<key> bun hodlmm-stop-loss.ts run --pool dlmm_3 --wallet SP2A37... --il-threshold 5 --exit-pct 50 --fee-cap 0.1 --max-exits 3"
---

# HODLMM Stop-Loss

A capital-protection skill for Bitflow HODLMM liquidity providers. Unlike bin-range monitors that only detect when a position goes out of range, this skill computes **impermanent loss in real time** — comparing the current USD value of your LP position against a HODL baseline captured at session start. When IL breaches your threshold for two consecutive cycles, it autonomously withdraws a configurable percentage of your liquidity via `withdraw-liquidity-same-multi` on the DLMM liquidity router.

## Architecture

- **Router:** `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1`
- **Function:** `withdraw-liquidity-same-multi`
- **Bin IDs:** converted from unsigned API values to signed contract offsets (`signed = unsigned - 500`)
- **Post-conditions:** `PostConditionMode.Allow` with aggregate `min-x-amount-total` / `min-y-amount-total` slippage floors (1% tolerance). DLP burn+mint in the same tx cannot be expressed as sender-side post-conditions — slippage protection is enforced by the router's built-in assertions.

## IL formula

```
HODL value  = entryAmountX * currentPriceX + entryAmountY * currentPriceY
LP value    = current position USD value (share of reserves)
IL%         = (HODL_value - LP_value) / HODL_value * 100
```

Entry snapshot captured once at session start. IL grows as price diverges from entry; shrinks as price reverts.

## Safety design

| Mechanism | Detail |
|---|---|
| 2-cycle confirmation window | IL must exceed threshold for 2 consecutive cycles before any exit |
| --fee-cap required | Refuses to start without explicit spend limit |
| 10-block cooldown (~100 min) | Block-based cooldown between exits on Stacks mainnet |
| --max-exits session cap | Hard upper bound of 10 exits per session |
| --dry-run mode | Full simulation without on-chain writes |
| Aggregate slippage floors | min-x/y-amount-total at 1% tolerance passed to router |

## Refusal conditions

- `--fee-cap` not provided
- `--exit-pct` > 100
- `--max-exits` > 10
- Wallet STX balance < 0.05 STX
- IL confirmation streak < 2
- Pool contract format invalid
- Position has zero DLP shares
