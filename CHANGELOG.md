# Changelog

## Unreleased

SemVer impact: patch.

- Centralize subagent result classification/diagnostics/parallel-summary policy and reuse it for API and display error semantics.
- Show richer project-agent trust diagnostics in approval/headless failure paths, including model, tools, paths/realpaths, and mutation-tool warnings.

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
