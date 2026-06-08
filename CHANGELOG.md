# Changelog

## Unreleased

## 3.1.0 - 2026-06-09

SemVer impact: minor.

- Bundle self-contained default agents (`scout`, `worker`, `verifier`, `reviewer`, `planner`, `advisor`) so normal subagent routing no longer depends on the global `pi-subagents` skill.
- Add optional shared global agent directories via `~/.pi/agent/extensions/subagents.json`, with path/symlink checks that prevent configured dirs from bypassing repo-agent trust.
- Restore canonical `agentScope: "global+repo"` plus compatibility aliases `user`, `project`, and `both` while keeping repo-local confirmation fail-closed by default.
- Improve collapsed subagent display with optional task `title`, final-output previews, table summaries, and hidden tool-call counts.
- Move scope/risk probing into the compact subagent tool guidance so fresh installs need less external `AGENTS.md` delegation policy.
- Trim prompt-facing subagent role examples to configured roles, replacing disabled `oracle`/`dispatcher` mentions with bundled `verifier` and `advisor` roles.

## 3.0.0 - 2026-05-27

SemVer impact: major.

- Simplify `agentScope` to only `global`, `repo`, or `both`; remove `user`, `project`, and `global+repo` compatibility aliases from the public tool schema and request validation.
- Rename repo-agent trust/result fields from `confirmProjectAgents` and `projectAgentsDir` to `confirmRepoAgents` and `repoAgentsDir`.

## 2.0.0 - 2026-05-25

SemVer impact: major.

- Remove caller-controlled `timeoutMs` from the `subagent` tool surface and use a fixed app-owned 10-minute deadline for child runs, so agents cannot force brittle short deadlines such as 60 seconds.
- Record reviewer-scout follow-up decisions: defer conversation-wide quotas/role allowlists and keep structured scout evidence benchmark-only for now.
- Record the first automated subagent-routing evaluation run and keep built-in `reduce` deferred pending repeat/additional-model evidence.

## 1.4.1 - 2026-05-25

SemVer impact: patch.

- Add structured scout-output validation to the reviewer-scout benchmark decision logs and gate.

## 1.4.0 - 2026-05-25

SemVer impact: minor.

- Add top-level `maxCalls` to bound subagent requests before spawning single, parallel, or chain runs.

## 1.3.4 - 2026-05-24

SemVer impact: patch.

- Render single-subagent results inline and hide default global provenance to reduce repeated TUI labels.

## 1.3.3 - 2026-05-24

SemVer impact: patch.

- Add compact subagent prompt guidance to use configured agent names and avoid invented generic agents such as `general`.

## 1.3.2 - 2026-05-24

SemVer impact: patch.

- Remove the absent `.pi/agents` package allowlist entry and document the intentional Pi dependency range policy.
- Rename reviewer-scout benchmark files, scorer, docs, and npm script from `reviewer-context-scout` to `reviewer-scout` terminology.

## 1.3.1 - 2026-05-24

SemVer impact: patch.

- Allow top-level `cwd`, `timeoutMs`, `maxOutputChars`, and `outputMode` to act as defaults for parallel tasks and chain steps, with per-item overrides.

## 1.3.0 - 2026-05-24

SemVer impact: minor.

- Prefer `global`, `repo`, and `global+repo` for `agentScope` schema/docs/display while preserving `user`, `project`, and `both` as aliases.

## 1.2.1 - 2026-05-24

SemVer impact: patch.

- Mark interactive project-agent cancellation as a tool error.

## 1.2.0 - 2026-05-24

SemVer impact: minor.

- Centralize subagent result classification/diagnostics/parallel-summary policy and reuse it for API and display error semantics, including timeout stop reasons.
- Show richer project-agent trust diagnostics in approval/headless failure paths, including model, tools, paths/realpaths, and mutation-tool warnings.
- Document advanced subagent workflow recipes and troubleshooting guidance in the README.
- Add an offline subagent-routing benchmark scorer, fixture set, and npm script for evaluating fanout-then-synthesis decisions without model/provider wiring.
- Add prompt-injection resilience fixtures to the subagent-routing benchmark so broad tasks resist anti-delegation text and tiny tasks resist overdelegation text.
- Record a prompt-only subagent-routing decision run comparing metadata-only, metadata-skill, improved-metadata, and schema-affordance conditions.
- Add an automated Pi prompt-only runner for collecting repeatable subagent-routing benchmark decision logs.
- Add reviewer-scout research docs plus an offline benchmark scorer, fixtures, tests, npm script, agent preflight, experimental reviewer-with-scout agent, prompt-only/no-scout decision logs, non-scout-call guardrail, and seeded file/line evidence scoring.
- Remove the experimental `context_scout` wrapper from the public tool surface and keep reviewer evidence lookup on the normal `subagent` → `scout` workflow.
- Add optional per-task runtime controls for `subagent`: `timeoutMs`, `maxOutputChars`, and `outputMode` for single, parallel, and chain steps.
- Preserve raw chain `{previous}` handoffs when `outputMode: "summary"` is set, with only `maxOutputChars` capping handoff text.
- Send subagent task prompts to child Pi processes over stdin instead of argv to reduce process-list exposure and argv-length risk.
- Bound child stdout buffering, JSON event size, and stored message size to prevent oversized subagent output from bloating parent runs.

## 1.1.2 - 2026-05-16

SemVer impact: patch.

- Clarify and test `cwd` semantics: agent discovery stays rooted at Pi's current workspace, while single/parallel/chain execution uses each requested run `cwd` when provided.
- Preserve structured result details for aborted subagents and subprocess spawn failures instead of losing them to thrown errors.
- Treat partial parallel subagent failures as tool errors and prefer error/stderr diagnostics over partial assistant output in parallel summaries.
- Add compact `subagent` prompt metadata plus a token-injection budget check for tool descriptions, schema, snippets, and guidelines.
- Preserve all text parts from the final assistant message in subagent outputs instead of only the first text part.

## 1.1.1 - 2026-05-14

- Surface invalid agent-file diagnostics in subagent error details instead of dropping them.
- Honor injected timer scheduling for subagent cleanup and abort fallback tests.

## 1.1.0 - 2026-05-14

- Fail closed for project-local agents in headless/JSON/print mode unless `confirmProjectAgents: false` is explicit.
- Split request normalization, agent catalog/trust policy, subprocess execution, and display-model logic into testable modules.
- Add automated Node test coverage for request validation, agent discovery, trust confirmation, subprocess lifecycle/error handling, and display output.
- Migrate package imports/dependencies to current Pi `@earendil-works/*` scopes and point the Pi manifest directly at `src/index.ts`.
- Expand README coverage for chain mode, agent scope, project-agent risk, confirmation behavior, installation, and compatibility.
