# pi-subagents

Pi package that adds a `subagent` tool for delegating work to specialized agents in isolated Pi processes. It supports single-agent runs, bounded parallel delegation, and chained handoffs.

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
pi install .
```

After installation, restart Pi or run `/reload`; the `subagent` tool should appear in the available tools list.

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

Project-local agents are repo-controlled prompts. When a requested agent resolves to `.pi/agents`, the tool asks for confirmation before execution. In headless/JSON/print modes, it fails closed unless you explicitly set:

```json
{ "confirmProjectAgents": false }
```

Only disable confirmation for repositories you trust.

## Diagnostics

Malformed JSON stdout events from subagent JSON mode are ignored so later valid events can continue; each ignored event is recorded in the subagent result's stderr diagnostics.

Aborted subagents and subprocess spawn failures are returned as structured result details (`stopReason`, diagnostics, and non-success tool results) so callers can inspect partial output instead of receiving an unstructured thrown error.

## Compatibility

This package targets current Pi package scopes (`@earendil-works/*`) and uses a direct `pi.extensions` entry for `./src/index.ts`.

## License

MIT. See `LICENSE`.
