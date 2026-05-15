# TODO — Active Backlog

Purpose: active open work only. Completed work belongs in `CHANGELOG.md`, git history, or release notes — not as checked-off TODO entries.

## P2 (User value / orchestration features)

1. [ ] Explore optional fanout-then-reduce orchestration.
   - Idea: run multiple subagents in parallel, then pass their outputs into a reducer agent.
   - Possible interface:
     ```json
     {
       "tasks": [{ "agent": "scout", "task": "..." }],
       "reduce": { "agent": "reviewer", "task": "Synthesize:\n{parallel}" }
     }
     ```
   - Validate whether this belongs in `subagent` or should remain a prompt pattern before implementing.

2. [ ] Add optional per-task runtime controls.
   - Candidate options: `timeoutMs`, `maxOutputChars`, `outputMode: "summary" | "full"`.
   - Keep defaults conservative and backward-compatible.
   - Add tests for timeout/error result semantics before implementation.

3. [ ] Add a prompt-injection effectiveness test for subagent routing.
   - Goal: measure whether compact `subagent` tool metadata teaches agents good delegation choices without loading the global `subagent-workflow` skill.
   - Suggested fixture set: tiny task should not delegate; broad codebase question should use scout/reviewer; risky change should request review/oracle; independent checks should use parallel; dependent handoff should use chain; project-agent prompt should preserve trust caution.
   - Compare decisions with tool metadata only vs. with the `subagent-workflow` skill loaded before deciding whether the skill can be retired.

4. [ ] Improve README with advanced workflow recipes.
   - Document recommended patterns: scout→worker→reviewer, parallel review lanes, chain handoff, project-agent trust guidance, and failure semantics.
   - Include a troubleshooting section for unknown agents, invalid frontmatter, JSON-mode diagnostics, and partial parallel failures.

## P3 (Maintenance / release)

5. [ ] Consider moving task prompts out of process argv.
   - Current behavior: `runSingleAgent` passes the user task as a CLI argument.
   - Potential issues: argv length limits and prompt visibility in process lists.
   - Investigate Pi CLI support for stdin or temp-file prompt input before changing.
