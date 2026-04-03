---
name: dao-proposal-monitor
description: "Monitors Stacks DAO governance proposals for unauthorized execution, status changes, and voting activity, alerting agents before on-chain actions are taken."
metadata:
  author: "Terese678"
  author-agent: "Bitflow Agent"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "dao-proposal-monitor/dao-proposal-monitor.ts"
  requires: "wallet, settings"
  tags: "defi, read, governance, dao, stacks, mainnet-only"
---

# dao-proposal-monitor

Monitors Stacks DAO governance proposals for unauthorized execution attempts, status changes, and voting threshold events. Alerts agents before on-chain actions are taken so they can respond or escalate.

## What It Does

- Polls active DAO proposals on Stacks via the Stacks API
- Detects proposals that are nearing execution threshold
- Flags proposals that have been executed without expected quorum
- Tracks new proposals submitted since last check
- Emits structured JSON alerts with severity levels: `info`, `warning`, `critical`

## Subcommands

| Command | Description |
|---------|-------------|
| `doctor` | Validates API connectivity, wallet config, and environment |
| `status` | Returns current snapshot of all active proposals |
| `run` | Starts continuous monitoring loop with alert emission |

## Output Contract

All output is strict JSON to stdout.

**doctor:**
```json
{
  "status": "ok",
  "checks": {
    "api": "reachable",
    "wallet": "loaded",
    "network": "mainnet"
  }
}
```

**status:**
```json
{
  "status": "success",
  "proposals": [
    {
      "id": "proposal-id",
      "title": "Proposal Title",
      "state": "active",
      "votesFor": 1200000,
      "votesAgainst": 300000,
      "quorum": 1000000,
      "executionBlock": 145000,
      "blocksRemaining": 120,
      "alert": null
    }
  ],
  "timestamp": 1712000000
}
```

**run (alert emission):**
```json
{
  "status": "alert",
  "severity": "critical",
  "alertType": "unauthorized-execution",
  "proposalId": "proposal-id",
  "message": "Proposal executed below quorum threshold",
  "data": {},
  "timestamp": 1712000000
}
```

## Alert Types

| Alert Type | Severity | Description |
|-----------|----------|-------------|
| `new-proposal` | info | A new proposal has been submitted |
| `quorum-approaching` | warning | Votes within 10% of quorum threshold |
| `execution-imminent` | warning | Less than 144 blocks (~24h) to execution window |
| `unauthorized-execution` | critical | Executed below quorum |
| `quorum-reached` | info | Proposal has reached quorum |
| `proposal-expired` | info | Proposal passed execution window without executing |

## Safety

- Read-only: no transactions are signed or broadcast
- Rate limited: max 1 API call per 10 seconds
- Hard stop: monitoring loop exits after 1000 cycles
- No private key access required

## Example Usage

```bash
# Check environment
bun run dao-proposal-monitor.ts doctor

# Get current proposal snapshot
bun run dao-proposal-monitor.ts status

# Start monitoring loop
bun run dao-proposal-monitor.ts run

# Monitor specific DAO contract
bun run dao-proposal-monitor.ts run --dao SP000000000000000000002Q6VF78.my-dao
```
