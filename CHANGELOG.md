# Changelog

## Unreleased

- Treat partial parallel subagent failures as tool errors and prefer error/stderr diagnostics over partial assistant output in parallel summaries.
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
