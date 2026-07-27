# Golden queries

Real questions asked of agents, with the document that should answer each.
This file seeds the recall@10 eval (phase 1 exit) — entries must come from
actual usage, not invented at a desk. Add one line each time an agent search
succeeds or should have succeeded.

Format: `query` → expected canonical doc id(s) — notes

## Entries

- `PAY-981` → jira:issue:PAY-981 — entity route, from fixture demo
- `how do payment retries work` → confluence:page:12345 — docs route, from fixture demo

<!-- Add real entries from Amp usage below. When ~25+ exist, promote this file
     into a structured eval fixture consumed by eval-runner in CI. -->
