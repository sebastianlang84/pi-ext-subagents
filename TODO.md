# TODO — Active Backlog

Purpose: active open work only. Completed work belongs in `CHANGELOG.md`, git history, or release notes — not as checked-off TODO entries.

## P2 (User value / orchestration features)

1. [ ] Explore optional fanout-then-reduce orchestration.
   - Canonical research plan: `docs/plans/fanout-reduce.md`.
   - Routing benchmark spec: `docs/plans/subagent-routing-benchmark.md`.
   - Next: run the benchmark to test whether tool metadata alone can trigger parallel-then-reducer behavior without explicit user prompting, while measuring false positives/schema gravity; do not prototype built-in `reduce` before bounded fanout output is implemented or otherwise enforced.

2. [ ] Add optional per-task runtime controls.
   - Candidate options: `timeoutMs`, `maxOutputChars`, `outputMode: "summary" | "full"`.
   - Keep defaults conservative and backward-compatible.
   - Add tests for timeout/error result semantics before implementation.

3. [ ] Add a prompt-injection effectiveness test for subagent routing.
   - Goal: measure whether compact `subagent` tool metadata teaches agents good delegation choices without loading the global `pi-subagents` skill.
   - Suggested fixture set: tiny task should not delegate; broad codebase question should use scout/reviewer; risky change should request review/oracle; independent checks should use parallel; dependent handoff should use chain; project-agent prompt should preserve trust caution.
   - Compare decisions with tool metadata only vs. with the `pi-subagents` skill loaded before deciding whether the skill should stay as complementary deep orchestration policy or be further shrunk.

## P3 (Maintenance / release)

4. [ ] Consider moving task prompts out of process argv.
   - Current behavior: `runSingleAgent` passes the user task as a CLI argument.
   - Potential issues: argv length limits and prompt visibility in process lists.
   - Investigate Pi CLI support for stdin or temp-file prompt input before changing.
