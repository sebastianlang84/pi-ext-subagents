# TODO — Active Backlog

Purpose: active open work only. Completed work belongs in `CHANGELOG.md`, git history, or release notes — not as checked-off TODO entries.

## P2 (User value / orchestration features)

1. [ ] Explore optional fanout-then-reduce orchestration.
   - Canonical research plan: `docs/plans/fanout-reduce.md`.
   - Routing benchmark spec: `docs/plans/subagent-routing-benchmark.md`.
   - Prompt-only decision run: `docs/benchmarks/subagent-routing-prompt-only-decisions.json`.
   - Result: metadata-only and minimal improved metadata passed; `metadata-skill` and schema-affordance missed positive fixtures, with no negative/schema-gravity false positives.
   - Automated runner: `npm run benchmark:subagent-routing:run -- --model <model> --output <decisions.json>`.
   - Next: collect automated runner results and/or additional-model runs before changing API surface; do not prototype built-in `reduce` yet.

2. [ ] Improve reviewer-scoped scout evidence through normal subagents.
   - Canonical research plan: `docs/plans/reviewer-scout.md`.
   - Goal: let reviewer subagents ask bounded, evidence-only context questions without recursive agent fanout or a second scout-like tool.
   - Benchmark scaffold: `docs/benchmarks/reviewer-scout-fixtures.json`, `scripts/score-reviewer-scout-benchmark.mjs`, `npm run benchmark:reviewer-scout`.
   - Prompt-only gate: reviewer-scout trials require an explicit reviewer agent that exposes `subagent` but not `bash`, `edit`, or `write`; scout must not expose `subagent`, `edit`, or `write`.
   - Prompt-only decision run: `docs/benchmarks/reviewer-scout-prompt-only-decisions.json` passes threshold gate, including seeded `evidenceRefs[]` file/line checks.
   - No-scout baseline: `docs/benchmarks/reviewer-scout-no-scout-decisions.json` intentionally misses 3/3 seeded positive evidence checks while passing tiny/adversarial cases.
   - Wrapper-specific product code/docs were removed; normal `subagent` → `scout` is the measured product path.
   - Benchmark/script names now use `reviewer-scout`.
   - Follow-ups to discuss:
     - Per-request budget enforcement now exists via top-level `maxCalls`; decide from evidence whether conversation-wide quotas or role allowlists are needed.
     - Structured scout evidence is now validated in benchmark decision logs; decide later whether runtime normalization is worth the schema/token surface.
