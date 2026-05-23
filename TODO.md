# TODO — Active Backlog

Purpose: active open work only. Completed work belongs in `CHANGELOG.md`, git history, or release notes — not as checked-off TODO entries.

## P2 (User value / orchestration features)

1. [ ] Explore optional fanout-then-reduce orchestration.
   - Canonical research plan: `docs/plans/fanout-reduce.md`.
   - Routing benchmark spec: `docs/plans/subagent-routing-benchmark.md`.
   - Next: run the benchmark to test whether tool metadata alone can trigger parallel-then-reducer behavior without explicit user prompting, while measuring false positives/schema gravity; bounded task output controls now exist, but do not prototype built-in `reduce` before benchmark evidence supports it.

2. [ ] Explore reviewer-scoped context scouts.
   - Canonical research plan: `docs/plans/reviewer-context-scout.md`.
   - Goal: let reviewer subagents ask bounded, evidence-only context questions without recursive agent fanout.
   - Benchmark scaffold: `docs/benchmarks/reviewer-context-scout-fixtures.json`, `scripts/score-reviewer-context-scout-benchmark.mjs`, `npm run benchmark:reviewer-context-scout`.
   - Prompt-only gate: default `reviewer` fails because it does not expose `subagent`; project-local `.pi/agents/reviewer-with-scout.md` passes preflight with the global `scout`.
   - Wrapper prototype: `context_scout` enforces fixed user-scope `scout`, max 2 calls per reviewer task, read-only scout tool allowlist, and output caps; `.pi/agents/reviewer-with-context-scout.md` opts into it.
   - Prompt-only decision run: `docs/benchmarks/reviewer-context-scout-prompt-only-decisions.json` passes threshold gate, including seeded `evidenceRefs[]` file/line checks.
   - Next: collect a wrapper decision run plus no-scout baseline / seeded review-miss cases to measure whether scout evidence catches issues that plain review misses.
   - Follow-ups to discuss:
     - Budget enforcement is post-run; over-budget scout work is returned as an error after completion rather than being interrupted live.
     - Tool/UX name `context_scout` is technical; consider a clearer reviewer-facing name such as `ask_scout`.
     - Scout output is currently raw text; consider validating/normalizing structured evidence refs, gaps, and confidence.
     - Default/global reviewer opt-in is unresolved; current staged agent is `.pi/agents/reviewer-with-context-scout.md`.

## P3 (Maintenance / release)

3. [ ] Consider moving task prompts out of process argv.
   - Current behavior: `runSingleAgent` passes the user task as a CLI argument.
   - Potential issues: argv length limits and prompt visibility in process lists.
   - Investigate Pi CLI support for stdin or temp-file prompt input before changing.
