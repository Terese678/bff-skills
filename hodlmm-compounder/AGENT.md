---
name: hodlmm-compounder-agent
skill: hodlmm-compounder
description: "Autonomously harvests and reinvests HODLMM trading fees to compound yield, with configurable thresholds, hard spend limits, cooldowns, and dry-run verification before any live execution."
---

# HODLMM Compounder Agent

## Role

This agent monitors unclaimed trading fees on a Bitflow HODLMM LP position and autonomously executes a two-step compound cycle: harvest fees by withdrawing fee-proportional liquidity, then reinvest the recovered tokens back into the active bin of the same pool. It signs and broadcasts real transactions — it is a **write agent** and requires explicit spend limits.

## Decision Order

1. Run `doctor` on startup — confirm API reachability, wallet loaded, pool exists
2. If `doctor` fails on any check, emit error JSON and **halt — do not proceed**
3. Run `status` to check current unclaimed fee balance
4. If unclaimed fees are **below `--min-threshold` (uSTX)**: emit blocked event, wait `--interval` seconds, repeat from step 3
5. If unclaimed fees **meet threshold**:
   a. Check cooldown — if last compound was < 3600 seconds ago, emit blocked event and wait
   b. Check compound count — if >= 20 this session, **halt and emit stopped**
   c. If `--dry-run` flag is set, simulate both harvest and reinvest and emit result — **do not broadcast**
   d. Execute `withdraw-liquidity-multi` — emit harvestTxId
   e. Wait for harvest confirmation (poll every 10s, timeout 300s)
   f. If harvest times out, emit warning and **skip reinvest for this cycle**
   g. If harvest confirmed, execute `add-relative-liquidity-same-multi` with harvested amounts — emit reinvestTxId
   h. Record timestamp, increment compound counter, start cooldown
   i. Emit full `compounded` JSON event

## Spend Limits (REQUIRED)

- **`--fee-cap <STX>`**: Maximum STX fee per transaction. Required for live execution. Agent refuses to run without this in live mode.
- **`--min-threshold <uSTX>`**: Minimum combined unclaimed fee value (in uSTX) before harvesting. Prevents frequent small transactions. Default: `10000`.
- **`--max-slippage <decimal>`**: Maximum slippage for both harvest and reinvest. Used to compute `min-dlp` on reinvest as `expectedDlp * (1 - maxSlippage)`. Default: `0.01` (1%).
- **Cooldown**: 3600 seconds between compound cycles. Hard-coded minimum, not configurable.
- **Session cap**: 20 compounds per `run` session. After 20, agent halts and requires manual restart.

## Guardrails

- **No fee-cap = no execution**: If `--fee-cap` is not set, agent refuses all live transactions
- **Harvest confirmation wait**: Agent polls every 10 seconds for up to 300 seconds for harvest tx to confirm before attempting reinvest. If timeout, emits warning and skips reinvest for that cycle — harvested funds are not lost
- **Slippage protection on reinvest**: `min-dlp` is computed from the pool's DLP/reserve ratio: `floor(expectedDlp * (1 - maxSlippage))`, minimum 1. This ensures the reinvest transaction fails on-chain if slippage exceeds the configured limit
- **Tight post-conditions on reinvest**: Uses `FungibleConditionCode.Equal` with exact harvested token amounts — transaction aborts if the contract consumes any different amount
- **Cooldown enforcement**: Timestamp checked every cycle. No bypass possible
- **Rate limit**: Max 1 Bitflow API call per 10 seconds. On 429, waits 30 seconds and retries
- **Dry-run first**: Always recommend operators verify with `--dry-run` before live execution
- **Minimum poll interval**: `--interval` minimum is 600 seconds (10 minutes), regardless of what is passed

## Refusal Conditions

Agent refuses to execute if:

- `doctor` fails (API unreachable, wallet not loaded, or pool not found)
- `--fee-cap` not set (live mode)
- Unclaimed fees below `--min-threshold`
- Cooldown active (< 3600s since last compound)
- Session compound count >= 20
- Harvest tx not confirmed within 300 seconds (reinvest skipped, cycle retried next interval)
- Pool not found in Bitflow API

## Output Events

All output is emitted as newline-delimited JSON to stdout.

Started:
```json
{ "status": "started", "config": { "poolId": "...", "wallet": "SP1234...", "maxSlippage": 0.01, "feeCap": 1.0, "minThreshold": 10000, "pollIntervalSeconds": 3600, "maxCompounds": 20, "dryRun": false }, "timestamp": 1712000000 }
```

Blocked:
```json
{ "status": "blocked", "reason": "below-threshold", "accumulatedFeesUSTX": 5000, "minThreshold": 10000, "timestamp": 1712000000 }
```

Heartbeat (every 5 cycles):
```json
{ "status": "heartbeat", "cycle": 5, "accumulatedFeesX": 1200, "accumulatedFeesY": 800, "compoundsExecuted": 1, "timestamp": 1712000000 }
```

Compounded:
```json
{ "status": "compounded", "action": "harvest-and-reinvest", "harvestedFeesX": 1200, "harvestedFeesY": 800, "reinvestedBins": [{ "binId": 8388700, "xAmount": 1200, "yAmount": 800 }], "harvestTxId": "0xabc...", "reinvestTxId": "0xdef...", "compoundCount": 1, "timestamp": 1712000000 }
```

Error:
```json
{ "error": "descriptive message", "code": "ERROR_CODE", "timestamp": 1712000000 }
```

Stopped:
```json
{ "status": "stopped", "reason": "max-compounds-reached", "compoundsExecuted": 20, "timestamp": 1712000000 }
```

## Operator Notes

- Always run `doctor` then `status` before enabling live `run`
- Use `--dry-run` for at least one full cycle before going live
- `--min-threshold` is in **uSTX** (micro-STX), not USD — set appropriately for your position size
- The agent never crashes silently — every exit produces a final JSON status line
- On SIGINT, agent emits a final stopped event with cycles completed and compounds executed before exiting
