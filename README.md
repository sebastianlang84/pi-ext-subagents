# pi-subagents

Pi package that adds a `subagent` tool for delegating work to specialized agents in isolated Pi processes, plus a bounded `context_scout` wrapper for reviewer evidence lookups. It supports single-agent runs, bounded parallel delegation, chained handoffs, and fixed-scout evidence packets.

## Install

```bash
pi install git:github.com/sebastianlang84/pi-ext-subagents
```

For local development:

```bash
git clone https://github.com/sebastianlang84/pi-ext-subagents.git
cd pi-ext-subagents
npm install
npm test
npm run check:token-injection
pi install .
```

After installation, restart Pi or run `/reload`; the `subagent` and `context_scout` tools should be available.

## Agent files

User agents live in `~/.pi/agent/agents/*.md`. Project-local agents live in `.pi/agents/*.md` under the current repo. Agent files use frontmatter plus a system prompt body:

```markdown
---
name: reviewer
description: Reviews changes for correctness and risk
tools: read, bash
model: openai-codex/gpt-5.5
---

You are a focused read-only reviewer...
```

`tools` must be a comma-separated string. Project agents override same-named user agents only when `agentScope` is `both`.

## Usage

Run one agent:

```json
{
  "agent": "reviewer",
  "task": "Review the current changes and list risks."
}
```

Run several agents in parallel (internally capped for concurrency):

```json
{
  "tasks": [
    { "agent": "reviewer", "task": "Review correctness." },
    { "agent": "tester", "task": "Suggest focused tests." }
  ]
}
```

Run a chain; `{previous}` is replaced with the previous step's final output:

```json
{
  "chain": [
    { "agent": "scout", "task": "Summarize the relevant files." },
    { "agent": "reviewer", "task": "Review this plan against the code:\n{previous}" }
  ]
}
```

## Runtime controls

Each single task, parallel task, or chain step can opt into runtime controls:

```json
{
  "agent": "reviewer",
  "task": "Review the diff briefly.",
  "timeoutMs": 30000,
  "maxOutputChars": 2000,
  "outputMode": "summary"
}
```

- `timeoutMs` fails the step as a timeout and terminates the child process if it exceeds the deadline.
- `maxOutputChars` bounds returned tool-result text for that step.
- `outputMode: "summary"` returns a status/preview; `"full"` returns the step output subject to any cap. Parallel mode remains summarized by default unless a task asks for `"full"`.

For parallel and chain modes, put these fields on each item in `tasks[]` or `chain[]`.

## Reviewer context scouting

`context_scout` asks the fixed user-scope `scout` agent a narrow reviewer evidence question without exposing generic subagent delegation. It enforces a per-reviewer-task call cap, fixed `scout` target, read-only tool allowlist for the spawned scout (`read`, `codemap_status`, `codemap_search`), read-file/search budgets, and output truncation.

Example:

```json
{
  "question": "Which tests cover the changed reviewer-context-scout scoring path?",
  "scope": "scripts/score-reviewer-context-scout-benchmark.mjs, tests/reviewer-context-scout-benchmark.test.mjs",
  "budget": { "maxFiles": 4, "maxOutputChars": 2000 }
}
```

The package includes `.pi/agents/reviewer-with-context-scout.md` as an experimental project-local reviewer that can call `context_scout` but not `subagent`.

## Workspace and `cwd` semantics

Agent discovery is rooted at Pi's current workspace (`ctx.cwd`). Project-local agents are discovered from the nearest `.pi/agents` directory at or above that workspace, not from a per-run execution `cwd`.

Execution uses the step `cwd` when provided, otherwise it falls back to the current workspace. In single mode this is the top-level `cwd`; in parallel and chain mode it is each task/step's `cwd`.

Prefer absolute `cwd` values. The extension validates that `cwd` is a non-empty string but does not resolve or normalize it before passing it to the child Pi process.

## Workflow guidance

The tool injects compact prompt guidance for when to delegate: use subagents for context isolation, independent review, or bounded specialist work; skip tiny tasks. Parallel mode is best for independent lanes, while chain mode is best for handoffs that depend on prior output. The main agent remains responsible for final judgment.

Keep delegated prompts explicit: goal, scope, constraints, allowed paths/tools, stop conditions, and desired output shape.

## Advanced workflow recipes

Use these as prompt patterns; the `subagent` tool does not enforce roles or sequencing beyond the requested single, parallel, or chain mode. For the open fanout-then-reduce research plan, see `docs/plans/fanout-reduce.md`.

### Scout → worker → reviewer

Use this for non-trivial implementation work where a separate read-only pass can shrink the context before changes:

1. Ask a `scout` agent to inspect the relevant files and return a compact brief with constraints, risks, and suggested edit points.
2. Apply the change in the main agent or delegate a bounded `worker` task with explicit allowed files and stop conditions.
3. Ask a `reviewer` agent to check the original request against the diff, verification output, and remaining risks.

### Parallel review lanes

Use parallel mode when checks are independent, for example one reviewer focused on correctness and another on tests or documentation:

```json
{
  "tasks": [
    { "agent": "reviewer", "task": "Review the diff for correctness and regressions." },
    { "agent": "tester", "task": "Suggest the smallest useful test coverage for this change." }
  ]
}
```

Parallel results may be partial: one failed task does not erase the other tasks' output, but the combined tool result is treated as an error when any task fails.

### Chain handoff

Use chain mode when each step depends on the previous step's compressed output. Include `{previous}` exactly where the next agent should receive the prior result:

```json
{
  "chain": [
    { "agent": "scout", "task": "Find the likely files and summarize constraints." },
    { "agent": "reviewer", "task": "Challenge this plan before implementation:\n{previous}" }
  ]
}
```

### Project-agent trust guidance

Prefer the default `agentScope: "user"` for untrusted repositories. Use `agentScope: "project"` or `"both"` only when you trust the repo-controlled `.pi/agents` prompts; interactive runs show confirmation details before executing project-local agents.

## Troubleshooting

- **Unknown agents:** verify the agent file exists in `~/.pi/agent/agents/*.md` for user scope or `.pi/agents/*.md` for project scope, and that the requested `agentScope` includes that source.
- **Invalid frontmatter:** ensure each agent file has `name` and `description` frontmatter. `tools` must be a comma-separated string, not a YAML list.
- **Project agents fail in JSON/headless mode:** project-local agents fail closed unless `confirmProjectAgents: false` is explicitly set for a trusted repository.
- **JSON-mode diagnostics:** malformed subagent JSON stdout events are skipped and recorded in the result diagnostics so later valid events can still complete.
- **Partial parallel failures:** inspect each task result. Successful task outputs remain available, while failed tasks include `stopReason`, stderr/error diagnostics, and a non-success tool result.

## Agent scope and security

By default only user agents are available:

```json
{ "agentScope": "user" }
```

Use project-local agents only for trusted repositories:

```json
{ "agentScope": "project" }
```

or combine both sources:

```json
{ "agentScope": "both" }
```

Project-local agents are repo-controlled prompts. When a requested agent resolves to `.pi/agents`, the tool asks for confirmation before execution and shows the agent model, tools, file path/realpath, plus warnings for mutation-capable tools such as `bash`, `write`, and `edit`. In headless/JSON/print modes, it fails closed with the same diagnostics unless you explicitly set:

```json
{ "confirmProjectAgents": false }
```

Only disable confirmation for repositories you trust.

## Diagnostics

Malformed JSON stdout events from subagent JSON mode are ignored so later valid events can continue; each ignored event is recorded in the subagent result's stderr diagnostics.

Aborted subagents and subprocess spawn failures are returned as structured result details (`stopReason`, diagnostics, and non-success tool results) so callers can inspect partial output instead of receiving an unstructured thrown error.

## Token-injection budget

Run the static prompt-footprint gate before increasing tool descriptions, parameter descriptions, `promptSnippet`, or `promptGuidelines`:

```bash
npm run check:token-injection
```

The report estimates tokens from normalized prompt-facing text and fails when registered tools exceed configured budgets.

## Compatibility

This package targets current Pi package scopes (`@earendil-works/*`) and uses a direct `pi.extensions` entry for `./src/index.ts`.

## License

MIT. See `LICENSE`.
