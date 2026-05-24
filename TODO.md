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
     - Budget enforcement is currently benchmark/prompt-level for normal subagent scout flow; decide from evidence whether generic runtime controls are needed.
     - Scout output is currently raw text; consider validating/normalizing structured evidence refs, gaps, and confidence.

3. [ ] Prevent agents from inventing a non-existent `general` subagent.
   - Observed failure: the model repeatedly calls `subagent` with `agent: "general"`, producing `Unknown agent: "general"`.
   - Current local global agents are `backlog-triager`, `oracle`, `planner`, `reviewer`, `scout`, and `worker`; this repo currently has no `.pi/agents/*.md` repo-local agents.
   - Root cause: `src/index.ts` exposes `agent` as an unconstrained string, `src/request.ts` only validates non-empty strings, and `src/execution.ts` rejects unknown names only after discovery. The compact tool metadata does not list valid roles, so the model guesses a generic role name.
   - Do not fix by silently aliasing `general`; that would hide bad routing and weaken role discipline.
   - Candidate fix: compress existing prompt-facing text enough to stay under the token-injection gate, then add a short affordance such as "Choose one of the available agent names; common global roles are scout, reviewer, worker, planner, oracle, and backlog-triager. If no role fits, do not delegate." Prefer parameter description/tool metadata over only global instructions, because it is visible at tool-call time.
   - Constraints: repository rule says keep prompt injection low; current `npm run check:token-injection --silent` report was 349/350 tokens for the `subagent` tool, so any new prompt-facing text likely requires removing or shortening existing metadata/schema descriptions.
   - Relevant files: `src/index.ts`, `src/request.ts`, `src/execution.ts`, `tests/token-injection.test.mjs`, `README.md` troubleshooting docs.
   - Verification: `npm test`, `npm run check:token-injection`, and a manual/fixture smoke check that vague delegation chooses an existing role or asks instead of calling `general`.
