# TODO — Active Backlog

Purpose: active open work only. Completed work belongs in `CHANGELOG.md`, git history, or release notes — not as checked-off TODO entries.

## P1 — Retire obsolete global `pi-subagents` skill

1. [ ] After `pi-subagents` v3.1.0 is installed/reloaded successfully, delete or archive the global `pi-subagents` skill. The extension now bundles the normal routing/safety/review/role-selection guidance needed for skill-free use.

## P2 — Optional fanout-then-reduce orchestration research

1. [ ] Explore optional fanout-then-reduce orchestration.
   - Canonical research plan: `docs/plans/fanout-reduce.md`.
   - Routing benchmark spec: `docs/plans/subagent-routing-benchmark.md`.
   - Evaluation execution plan: `docs/plans/subagent-routing-eval-plan.md`.
   - Existing run artifacts live under `docs/benchmarks/`; do not duplicate historical result details in this active backlog.
   - Next: repeat automated run and/or run another model before prompt-facing/API changes; do not prototype built-in `reduce` yet.
