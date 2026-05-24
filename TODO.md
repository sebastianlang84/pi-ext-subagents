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
   - Canonical research plan: `docs/plans/reviewer-context-scout.md`.
   - Goal: let reviewer subagents ask bounded, evidence-only context questions without recursive agent fanout or a second scout-like tool.
   - Benchmark scaffold: `docs/benchmarks/reviewer-context-scout-fixtures.json`, `scripts/score-reviewer-context-scout-benchmark.mjs`, `npm run benchmark:reviewer-context-scout`.
   - Prompt-only gate: default `reviewer` fails because it does not expose `subagent`; project-local `.pi/agents/reviewer-with-scout.md` passes preflight with the global `scout`.
   - Prompt-only decision run: `docs/benchmarks/reviewer-context-scout-prompt-only-decisions.json` passes threshold gate, including seeded `evidenceRefs[]` file/line checks.
   - No-scout baseline: `docs/benchmarks/reviewer-context-scout-no-scout-decisions.json` intentionally misses 3/3 seeded positive evidence checks while passing tiny/adversarial cases.
   - Wrapper-specific product code/docs were removed; normal `subagent` → `scout` is the measured product path.
   - Next: decide whether benchmark/script names should be renamed from `context-scout` to `reviewer-scout`.
   - Follow-ups to discuss:
     - Budget enforcement is currently benchmark/prompt-level for normal subagent scout flow; decide from evidence whether generic runtime controls are needed.
     - Scout output is currently raw text; consider validating/normalizing structured evidence refs, gaps, and confidence.
