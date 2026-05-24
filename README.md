# pi-subagents

Pi package that adds a `subagent` tool for delegating work to specialized agents in isolated Pi processes. It supports single-agent runs, bounded parallel delegation, chained handoffs, and reviewer evidence lookups through normal scout subagents.

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

After installation, restart Pi or run `/reload`; the `subagent` tool should be available by default.

## Agent files

Global agents live in `~/.pi/agent/agents/*.md`. Repo-local agents live in `.pi/agents/*.md` under the current repo. Agent files use frontmatter plus a system prompt body:

```markdown
---
name: reviewer
description: Reviews changes for correctness and risk
tools: read, bash
model: openai-codex/gpt-5.5
---

You are a focused read-only reviewer...
```

`tools` must be a comma-separated string. Repo-local agents override same-named global agents only when `agentScope` is `global+repo` (`both` remains a legacy alias).

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

For parallel and chain modes, put these fields on each item in `tasks[]` or `chain[]`. In chains, `{previous}` receives the prior step's raw final output; `maxOutputChars` can cap that handoff, but `outputMode` only affects returned tool-result text.

## Reviewer scout evidence

Use the normal `subagent` tool with agent `scout` when a reviewer needs delegated evidence. `scout` is an agent role, not a separate tool.

Example:

```json
{
  "agent": "scout",
  "task": "Find the tests and code paths relevant to the changed reviewer-scout benchmark. Return concise evidence with file/line refs, gaps, and confidence.",
  "maxOutputChars": 2000,
  "outputMode": "summary"
}
```

No special reviewer agent is required. If a reviewer is allowed to use `subagent`, keep the prompt contract narrow: call only `scout`, keep final judgment with the reviewer, and avoid scout calls for tiny/local tasks.

## Workspace and `cwd` semantics

Agent discovery is rooted at Pi's current workspace (`ctx.cwd`). Repo-local agents are discovered from the nearest `.pi/agents` directory at or above that workspace, not from a per-run execution `cwd`.

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

### Repo-agent trust guidance

Prefer the default `agentScope: "global"` for untrusted repositories. Use `agentScope: "repo"` or `"global+repo"` only when you trust the repo-controlled `.pi/agents` prompts; interactive runs show confirmation details before executing repo-local agents. Legacy aliases `"user"`, `"project"`, and `"both"` are still accepted.

## Troubleshooting

- **Unknown agents:** verify the agent file exists in `~/.pi/agent/agents/*.md` for global scope or `.pi/agents/*.md` for repo scope, and that the requested `agentScope` includes that source.
- **Invalid frontmatter:** ensure each agent file has `name` and `description` frontmatter. `tools` must be a comma-separated string, not a YAML list.
- **Repo agents fail in JSON/headless mode:** repo-local agents fail closed unless `confirmProjectAgents: false` is explicitly set for a trusted repository.
- **JSON-mode diagnostics:** malformed subagent JSON stdout events are skipped and recorded in the result diagnostics so later valid events can still complete.
- **Partial parallel failures:** inspect each task result. Successful task outputs remain available, while failed tasks include `stopReason`, stderr/error diagnostics, and a non-success tool result.

## Agent scope and security

By default only global agents are available:

```json
{ "agentScope": "global" }
```

Use repo-local agents only for trusted repositories:

```json
{ "agentScope": "repo" }
```

or combine both sources:

```json
{ "agentScope": "global+repo" }
```

Legacy aliases remain accepted for compatibility: `"user"` → `"global"`, `"project"` → `"repo"`, and `"both"` → `"global+repo"`.

Repo-local agents are repo-controlled prompts. When a requested agent resolves to `.pi/agents`, the tool asks for confirmation before execution and shows the agent model, tools, file path/realpath, plus warnings for mutation-capable tools such as `bash`, `write`, and `edit`. In headless/JSON/print modes, it fails closed with the same diagnostics unless you explicitly set:

```json
{ "confirmProjectAgents": false }
```

Only disable confirmation for repositories you trust.

## Diagnostics

Malformed JSON stdout events from subagent JSON mode are ignored so later valid events can continue; each ignored event is recorded in the subagent result's stderr diagnostics.

Aborted subagents and subprocess spawn failures are returned as structured result details (`stopReason`, diagnostics, and non-success tool results) so callers can inspect partial output instead of receiving an unstructured thrown error.

Child stdout buffering, JSON event size, and stored message size are internally bounded. Oversized stdout events fail the subagent with diagnostics; oversized stored messages are truncated with diagnostics while preserving usage metadata when available.

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
