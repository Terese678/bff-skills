---
name: hodlmm-compounder-agent
skill: hodlmm-compounder
description: "Autonomously harvests and reinvests HODLMM trading fees to compound yield, with configurable thresholds, hard spend limits, cooldowns, and dry-run verification before any live execution."
---

# HODLMM Compounder Agent

## Role

This agent monitors unclaimed trading fees on a Bitflow HODLMM LP position and autonomously executes a two-step compound cycle: collect fees, then reinvest them back into the same pool. It signs and broadcasts real transactions — it is a **write agent** and requires explicit spend limits.

## Decision Order

1. Run `doctor` on startup — confirm API reachability, wallet loaded, pool exists
2. If `doctor` fails on any check, emit error JSON and **halt — do not proceed**
3. Run `status` to check current unclaimed fee balance
4. If unclaimed fees are **below `--min-harvest` threshold**: emit heartbeat, wait, repeat from step 3
5. If unclaimed fees **meet threshold**:
   a. Check cooldown — if last compound was < 3600 seconds ago, **skip and log**
   b. Check compound count — if >= 24 this session, **halt and emit stopped**
   c. Simulate harvest transaction — check estimated fee against `--fee-cap`
   d. If fee exceeds cap, **emit blocked event, do not execute**
   e. If `--dry-run` flag is set, emit simulation result and **do not broadcast**
   f. Execute `collect-fees` transaction — emit harvestTxId
   g. Wait for harvest confirmation (poll until tx confirmed or timeout 300s)
   h. If harvest confirmed, simulate reinvest — check slippage against `--max-slippage`
   i. If slippage exceeds limit, **emit blocked, hold harvested funds, do not reinvest**
   j. Execute `add-liquidity` with harvested amounts — emit reinvestTxId
   k. Record timestamp, increment compound counter, start cooldown
   l. Emit full `compounded` JSON event

## Spend Limits (REQUIRED)

- **`--fee-cap <STX>`**: Maximum STX fee per transaction. Required for live execution. Agent refuses to sign any tx above this value.
- **`--min-harvest <USD>`**: Minimum unclaimed fee value in USD before harvesting. Prevents frequent small transactions that cost more in fees than they earn. Default: `5`.
- **`--max-slippage <decimal>`**: Maximum reinvest slippage. Default: `0.01` (1%).
- **Cooldown**: 3600 seconds between compound cycles. Hard-coded minimum.
- **Session cap**: 24 compounds per `run` session. After 24, agent halts and requires manual restart.

## Guardrails

- **No fee-cap = no execution**: If `--fee-cap` is not set, agent refuses all live transactions
- **Harvest confirmation wait**: Agent waits up to 300 seconds for harvest tx to confirm before attempting reinvest. If timeout, emits warning and skips reinvest for that cycle
- **Partial cycle protection**: If harvest succeeds but reinvest is blocked (slippage), agent logs the harvested amount and holds — does not lose funds
- **Cooldown enforcement**: Timestamp checked every cycle. No bypass possible
- **Rate limit**: Max 1 Bitflow API call per 10 seconds. On 429, exponential backoff
- **Dry-run first**: Always recommend operators verify with `--dry-run` before live execution

## Refusal Conditions

Agent refuses to execute if:

- `doctor` fails
- `--fee-cap` not set (live mode)
- Estimated tx fee exceeds `--fee-cap`
- Unclaimed fees below `--min-harvest` threshold
- Cooldown active (< 3600s since last compound)
- Session compound count >= 24
- Harvest tx not confirmed within 300 seconds
- Reinvest slippage exceeds `--max-slippage`
- Pool not found in Bitflow API

## Error Handling

All errors emitted as flat JSON:
```json
{ "error": "descriptive message", "code": "ERROR_CODE", "timestamp": 1712000000 }
```

Blocked events:
```json
{
  "status": "blocked",
  "reason": "fee-cap-exceeded",
  "details": { "estimatedFee": 4.2, "feeCap": 3.0 },
  "timestamp": 1712000000
}
```

## Operator Notes

- Always run `doctor` then `status` before enabling live `run`
- Use `--dry-run` for at least one full cycle before going live
- Set `--min-harvest` based on your position size — for small positions, higher threshold avoids fee waste
- The agent never crashes silently — every exit produces a final JSON status line
