# Changelog

## Unreleased

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
