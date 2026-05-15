# TODO — Active Backlog

Purpose: active open work only. Completed work belongs in `CHANGELOG.md`, git history, or release notes — not as checked-off TODO entries.

## P1 (Architecture deepening / testability)

1. [ ] Extract a deep execution orchestration module.
   - Current friction: `src/index.ts` owns request validation handling, discovery, trust confirmation, mode execution, summaries, and UI rendering glue.
   - Proposed seam: an execution module that takes a normalized plan plus adapters (`runner`, `confirmer`, `agentDiscovery`) and returns a tool result/details model.
   - Benefit: public tool behavior becomes integration-testable without spawning real Pi processes.

2. [ ] Clarify and test workspace/CWD semantics.
   - Problem: agent discovery uses `ctx.cwd`, but each step can execute with its own `cwd`.
   - Decide the interface: what is the discovery root, what is the run cwd, and how should project-local agents behave when step cwd differs?
   - Add behavior tests for single, parallel, and chain calls with `cwd`/step `cwd`.

3. [ ] Deepen project-agent trust diagnostics.
   - Current prompt shows only agent names and project agents directory.
   - Add model/tools/file path/realpath information to the approval prompt and headless error details.
   - Consider stronger warnings for project agents with mutation-capable tools such as `bash`, `write`, or `edit`.

4. [ ] Introduce a result-summary policy seam.
   - Current summary policy is hard-coded in `buildParallelResultSummary`.
   - Proposed interface: centralize success/failure classification, diagnostic precedence, truncation limits, and possibly `outputMode`.
   - Benefit: single, parallel, chain, display, and API result semantics stay consistent.

## P2 (User value / orchestration features)

5. [ ] Explore optional fanout-then-reduce orchestration.
   - Idea: run multiple subagents in parallel, then pass their outputs into a reducer agent.
   - Possible interface:
     ```json
     {
       "tasks": [{ "agent": "scout", "task": "..." }],
       "reduce": { "agent": "reviewer", "task": "Synthesize:\n{parallel}" }
     }
     ```
   - Validate whether this belongs in `subagent` or should remain a prompt pattern before implementing.

6. [ ] Add optional per-task runtime controls.
   - Candidate options: `timeoutMs`, `maxOutputChars`, `outputMode: "summary" | "full"`.
   - Keep defaults conservative and backward-compatible.
   - Add tests for timeout/error result semantics before implementation.

7. [ ] Improve README with advanced workflow recipes.
   - Document recommended patterns: scout→worker→reviewer, parallel review lanes, chain handoff, project-agent trust guidance, and failure semantics.
   - Include a troubleshooting section for unknown agents, invalid frontmatter, JSON-mode diagnostics, and partial parallel failures.

## P3 (Maintenance / release)

8. [ ] Consider moving task prompts out of process argv.
   - Current behavior: `runSingleAgent` passes the user task as a CLI argument.
   - Potential issues: argv length limits and prompt visibility in process lists.
   - Investigate Pi CLI support for stdin or temp-file prompt input before changing.

9. [ ] Add local install smoke before release.
   - Run `pi install .`, restart or `/reload`, then confirm the `subagent` tool appears and can run a trivial user agent.

10. [ ] Choose the next release version and move `CHANGELOG.md` `Unreleased` entries into that release section before publishing/tagging.
