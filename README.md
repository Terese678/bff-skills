# BFF Skills — Staging Repo

> **This is a staging repo.** for the AIBTC x BITFLOW DeFi Skill Competition. Submit your skill here via PR. Approved skills get pushed to the official [AIBTC skills registry](https://aibtc.com/skills).

---

## The AIBTC × BFF Skills Competition

**$100/day in BTC** to the best DeFi skill submitted. 30 days. On-chain proof required. Best skill each day wins.

**Bonus:** +$1,000 BTC pool for skills that directly integrate HODLMM.

- **Announce:** Monday, March 23
- **Submissions open:** Wednesday, March 25
- **Prize paid in:** BTC, automatically on approval

---

## Skill Categories

Submit in any of these categories — broad by design:

- **Trading** — swaps, arb detection, price impact, execution logic
- **Yield** — LP management, fee harvesting, yield dashboards, rebalance strategies
- **Infrastructure** — escrow, oracles, agent-to-agent comms, data freshness monitors
- **Signals** — market signals, risk alerts, portfolio monitoring, trade rationale

---

## How to Submit

### 1. Fork this repo

### 2. Create your skill directory

```
skills/
└── your-skill-name/
    ├── SKILL.md
    ├── AGENT.md
    └── your-skill-name.ts
```

Follow the [`SKILL_TEMPLATE.md`](./SKILL_TEMPLATE.md) exactly — the AIBTC validator will reject submissions with missing or malformed frontmatter.

### 3. Validate before you open a PR

```bash
bun run scripts/validate-frontmatter.ts
bun run scripts/generate-manifest.ts
bun run skills/your-skill-name/your-skill-name.ts doctor
```

Attach the output of these commands in your PR description.

### 4. Open a Pull Request

Use the PR template — it auto-fills when you open one. Required fields:

- What the skill does
- On-chain proof (tx link or live output) — **no proof = not reviewed**
- Whether it integrates HODLMM (eligible for +$1K bonus pool)
- Smoke test results

### 5. Review & approval

PRs are reviewed by the BFF Army council (humans + a Bitflow agent). Expect feedback within 24 hours. Fix requested changes fast — reviewer responsiveness is part of the process.

### 6. Winners

Daily winners are announced on [@BitflowFinance](https://twitter.com/BitflowFinance) and listed at [bitflow.finance/agents.txt](https://bitflow.finance/agents.txt). Winning skills get pushed to the AIBTC skills registry and wrapped with BFF Army guides and bootcamps.

---

## Judging Criteria

| Criteria | What we're looking for |
|---|---|
| **Reliability** | Idempotent reruns, safe defaults, handles errors explicitly |
| **Security** | No secret leakage, clear warnings on writes or fund movements |
| **Structure** | Valid SKILL.md frontmatter, AGENT.md behavior rules, JSON output contract |
| **Proof** | On-chain tx or live command output proving it works end-to-end |
| **HODLMM integration** | Eligible for the +$1K bonus pool |

---

## Resources

- [SKILL_TEMPLATE.md](./SKILL_TEMPLATE.md) — required format for all submissions
- [AIBTC Skills Registry](https://aibtc.com/skills) — where approved skills are published
- [BFF Army](https://bff.army) — guides, courses, and bootcamps for winning skills
- [bitflow.finance/agents.txt](https://bitflow.finance/agents.txt) — daily winners and competition updates
- [HODLMM](https://bitflow.finance) — the liquidity infrastructure your skills can plug into

---

## Questions

Open an issue or find us in the [Bitflow Discord](https://discord.gg/bitflow).
