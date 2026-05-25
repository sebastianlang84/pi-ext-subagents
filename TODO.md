# TODO — Active Backlog

Purpose: active open work only. Completed work belongs in `CHANGELOG.md`, git history, or release notes — not as checked-off TODO entries.

## P2 (User value / orchestration features)

1. [ ] Explore optional fanout-then-reduce orchestration.
   - Canonical research plan: `docs/plans/fanout-reduce.md`.
   - Routing benchmark spec: `docs/plans/subagent-routing-benchmark.md`.
   - Evaluation execution plan: `docs/plans/subagent-routing-eval-plan.md`.
   - Prompt-only decision run: `docs/benchmarks/subagent-routing-prompt-only-decisions.json`.
   - Prompt-only result: metadata-only and minimal improved metadata passed; `metadata-skill` and schema-affordance missed positive fixtures, with no negative/schema-gravity false positives.
   - Automated runner: `npm run benchmark:subagent-routing:run -- --model <model> --output <decisions.json>`.
   - Automated run report: `docs/benchmarks/subagent-routing-report-2026-05-25.md`.
   - Automated result: `openai-codex/gpt-5.5` passed threshold gate; metadata-only and improved-metadata overdelegated `S2` normal review, while metadata-skill and schema-affordance had no misses.
   - Next: repeat automated run and/or run another model before prompt-facing/API changes; do not prototype built-in `reduce` yet.
