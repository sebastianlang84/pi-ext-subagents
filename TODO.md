# TODO — Active Backlog

Purpose: active open work only. Completed work belongs in `CHANGELOG.md`, git history, or release notes — not as checked-off TODO entries.

## P0 (High-value correctness / UX)

1. [ ] Improve parallel result diagnostics.
   - Problem: `buildParallelResultSummary` truncates each result to 100 chars and, for failed agents, can prefer assistant output over `errorMessage`/`stderr`.
   - Target behavior: failed results should surface `errorMessage || stderr || finalOutput`; successful results should surface final output.
   - Add behavior tests for failed parallel results with both assistant text and stderr/error diagnostics.

2. [ ] Preserve complete final text output.
   - Problem: `getFinalOutput` returns only the first text part of the last assistant message.
   - Target behavior: collect all text parts from the final assistant message in order.
   - Add a behavior test with multiple text parts.

3. [ ] Make aborts and subprocess failures preserve structured details.
   - Problem: abort paths can throw from `runSingleAgent`, risking loss of partial details at the tool level.
   - Target behavior: aborts should become a `SingleResult` with `stopReason: "aborted"`, diagnostics, and `isError: true` in single/parallel/chain summaries.
   - Add tests for single and parallel abort behavior through the public tool execution path if feasible.

## P1 (Architecture deepening / testability)

4. [ ] Extract a deep execution orchestration module.
   - Current friction: `src/index.ts` owns request validation handling, discovery, trust confirmation, mode execution, summaries, and UI rendering glue.
   - Proposed seam: an execution module that takes a normalized plan plus adapters (`runner`, `confirmer`, `agentDiscovery`) and returns a tool result/details model.
   - Benefit: public tool behavior becomes integration-testable without spawning real Pi processes.

5. [ ] Clarify and test workspace/CWD semantics.
   - Problem: agent discovery uses `ctx.cwd`, but each step can execute with its own `cwd`.
   - Decide the interface: what is the discovery root, what is the run cwd, and how should project-local agents behave when step cwd differs?
   - Add behavior tests for single, parallel, and chain calls with `cwd`/step `cwd`.

6. [ ] Deepen project-agent trust diagnostics.
   - Current prompt shows only agent names and project agents directory.
   - Add model/tools/file path/realpath information to the approval prompt and headless error details.
   - Consider stronger warnings for project agents with mutation-capable tools such as `bash`, `write`, or `edit`.

7. [ ] Introduce a result-summary policy seam.
   - Current summary policy is hard-coded in `buildParallelResultSummary`.
   - Proposed interface: centralize success/failure classification, diagnostic precedence, truncation limits, and possibly `outputMode`.
   - Benefit: single, parallel, chain, display, and API result semantics stay consistent.

## P2 (User value / orchestration features)

8. [ ] Explore optional fanout-then-reduce orchestration.
   - Idea: run multiple subagents in parallel, then pass their outputs into a reducer agent.
   - Possible interface:
     ```json
     {
       "tasks": [{ "agent": "scout", "task": "..." }],
       "reduce": { "agent": "reviewer", "task": "Synthesize:\n{parallel}" }
     }
     ```
   - Validate whether this belongs in `subagent` or should remain a prompt pattern before implementing.

9. [ ] Add optional per-task runtime controls.
   - Candidate options: `timeoutMs`, `maxOutputChars`, `outputMode: "summary" | "full"`.
   - Keep defaults conservative and backward-compatible.
   - Add tests for timeout/error result semantics before implementation.

10. [ ] Improve README with advanced workflow recipes.
   - Document recommended patterns: scout→worker→reviewer, parallel review lanes, chain handoff, project-agent trust guidance, and failure semantics.
   - Include a troubleshooting section for unknown agents, invalid frontmatter, JSON-mode diagnostics, and partial parallel failures.

## P3 (Maintenance / release)

11. [ ] Consider moving task prompts out of process argv.
   - Current behavior: `runSingleAgent` passes the user task as a CLI argument.
   - Potential issues: argv length limits and prompt visibility in process lists.
   - Investigate Pi CLI support for stdin or temp-file prompt input before changing.

12. [ ] Add local install smoke before release.
   - Run `pi install .`, restart or `/reload`, then confirm the `subagent` tool appears and can run a trivial user agent.

13. [ ] Choose the next release version and move `CHANGELOG.md` `Unreleased` entries into that release section before publishing/tagging.
