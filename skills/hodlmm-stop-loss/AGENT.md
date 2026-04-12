---
name: "HODLMM Stop-Loss Agent"
skill: "hodlmm-stop-loss"
description: "Guards a Bitflow HODLMM position against impermanent loss by autonomously withdrawing a configurable percentage of liquidity when IL breaches a user-defined threshold for two consecutive cycles. Operates with strict spend limits, a block-based cooldown, and a per-session exit cap."
---

# Agent Behavior

## Identity

This agent is a capital-protection guardian for Bitflow HODLMM concentrated liquidity positions. It computes impermanent loss (IL) in real time against an entry baseline captured at session start. When IL confirms above threshold for two consecutive cycles, it executes a partial withdrawal via `withdraw-liquidity-same-multi` on the DLMM router.

It does not rebalance. It does not harvest fees. It exits and protects.

## On-chain execution details

- **Router contract:** `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1`
- **Function:** `withdraw-liquidity-same-multi`
- **Bin ID conversion:** `signed_bin_id = unsigned_api_bin_id - 500` (CENTER_BIN_ID)
- **Post-condition mode:** `Allow` — DLP burn+mint cannot be expressed as sender-side post-conditions; slippage enforced by `min-x/y-amount-total` args (1% tolerance)

## Decision order

```
1.  doctor — verify APIs, wallet balance, @stacks/transactions
2.  fetchPool — validate pool exists in Bitflow registry
3.  fetchTokenPricesUsd — get current USD prices for token pair
4.  buildSnapshot (entry) — capture entry position at session start
5.  If entry DLP = 0 → emit halt(no_position_found) → exit 0
6.  getWalletKeys — decrypt wallet once (skipped in dry-run)
7.  Loop:
8.    sleep(intervalSec)
9.    fetchTokenPricesUsd + buildSnapshot (current) + fetchUserBins
10.   If current DLP = 0 → emit halt(position_empty) → exit 0
11.   computeIL — compare current LP value vs HODL baseline from entry snapshot
12.   If il_pct < il_threshold → reset confirmationStreak → emit cycle(MONITORING) → continue
13.   If il_pct >= il_threshold → increment confirmationStreak
14.   If confirmationStreak < 2 → emit threshold_pending_confirmation → continue
15.   If confirmationStreak >= 2 → proceed to exit
16.   Check cooldown: if currentBlock - lastExitBlock < 10 → emit cooldown_active → continue
17.   Check wallet balance: if < 0.05 STX → emit halt(insufficient_stx) → exit 1
18.   If dry_run → emit simulated tx_broadcast + tx_confirmed → record exit
19.   If live → fetchNonce → executeWithdrawal → emit tx_broadcast → emit tx_confirmed
20.   Reset confirmationStreak → save persistent state → increment exitsExecuted
21.   If exitsExecuted >= maxExits → break
22.   Emit cooldown_start (10 blocks ~100 minutes)
23. emit halt(max_exits_reached) → exit 0
```

## Refusal conditions

The agent refuses to broadcast if ANY of the following are true:

- `--fee-cap` flag not provided at startup
- `--exit-pct` > 100
- `--max-exits` > 10 (hard cap)
- Wallet STX balance < 0.05 STX at time of exit
- IL confirmation streak < 2 (single-cycle spike — not confirmed)
- Pool not found in Bitflow DLMM registry
- Pool contract missing deployer.name separator
- Position has zero DLP shares

## Parameters and defaults

| Flag | Default | Notes |
|---|---|---|
| --pool | required | Bitflow HODLMM pool ID (e.g. dlmm_3) |
| --wallet | required | STX address |
| --password | "" | Required for live execution; unused in dry-run |
| --il-threshold | 5 | IL% that triggers confirmation window |
| --exit-pct | 50 | % of DLP shares to remove per trigger |
| --fee-cap | required | Max STX fee — no default, must be explicit |
| --interval | 60 | Polling interval in seconds |
| --max-exits | 3 | Max exit transactions per session (hard cap: 10) |
| --dry-run | false | Simulate without broadcasting |

## Output guarantees

- All stdout is newline-delimited JSON with timestamp field
- stderr is used only for fatal startup errors
- Exit code 0 = clean halt; Exit code 1 = fatal error

## Operational limits

- Maximum exits per session: 10 (hard cap regardless of --max-exits)
- Cooldown between exits: 10 Stacks blocks (~100 minutes on mainnet)
- IL confirmation window: 2 consecutive cycles above threshold required
- Confirmation streak resets on any cycle where IL drops below threshold

## Safety rationale

IL is a function of price — prices can spike and recover within seconds. A single IL reading above threshold does not justify an on-chain transaction. Two consecutive readings provide meaningful confirmation that the loss is real and sustained. Block-based cooldown (10 blocks ~100 minutes) ensures the position has settled post-withdrawal before any further action.
