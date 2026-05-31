# Dispatcher smoke report — 2026-05-31

Purpose: validate the local optional `dispatcher` agent as a shallow preflight router. The dispatcher should recommend the minimal safe route, estimate scope volume, split scout work when one scout would be overloaded, and must not deep-scout, plan, implement, verify, review, or choose backlog priorities.

Fixture source: `docs/benchmarks/dispatcher-smoke-fixtures.json`.

## Live smoke results

Run mode: manual `subagent` calls against the local global `dispatcher` agent.

| Fixture | Expected | Observed | Result |
| --- | --- | --- | --- |
| D1 tiny memory/TODO request | `direct`, no scout split | `direct`, no scout split, overload low | pass |
| D2 unfamiliar auth/session schema migration | `sequence: 2 scouts -> planner` | `sequence: 2 scouts -> planner`, lanes `API/contracts` + `DB/persistence+tests`, overload high | pass |
| D3 newsletter transcript evidence diagnosis | `parallel scouts`, 3 lanes | `parallel scouts`, lanes `transcript-evidence` + `run-artifacts` + `writer/auditor-code`, overload high | pass |
| D4 broad monorepo audit | `sequence: parallel scouts -> planner`, 2-4 lanes | `sequence: parallel scouts -> planner`, lanes `architecture-risk` + `tests-ci` + `docs-drift` + `security-config`, overload high | pass |

## Notes

- Initial D2 output recommended `planner` directly. The dispatcher prompt was tightened to prefer `sequence: scout -> planner` when relevant files/ownership are unknown but high-risk sequencing is needed.
- Follow-up scope-volume tightening added explicit `Scope volume`, `Scout split`, `Per-scout budget`, and `Overload risk` fields. This caught broad/risky tasks that should not be sent to one scout.
- A reviewer pass found no must-fix issues. The only concern was wording that implied an active backlog triage agent; the dispatcher prompt now says to use a dedicated backlog-triage agent only if one is active.
- These smoke fixtures document behavior expectations. Deterministic package tests only validate the fixture corpus shape; live LLM behavior still requires manual or automated Pi runs.

## Suggested rerun prompts

Use the prompts in `dispatcher-smoke-fixtures.json` and check that the returned `## Dispatch` block matches the expected route, size/risk direction, scout split, per-scout budget, and overload-risk guidance.
