# pi-subagents

Pi extension for delegating work to specialized subagents with isolated context windows. It supports single-agent runs, parallel delegation, and chained handoffs.

## Install

```bash
pi install git:github.com/sebastianlang84/pi-ext-subagents
```

For local development:

```bash
cd ~/dev/pi-extensions/pi-ext-subagents
pi install .
```

## Usage

Call the `subagent` tool with one agent:

```json
{
  "agent": "reviewer",
  "task": "Review the current changes and list risks."
}
```

Or run multiple agents in parallel:

```json
{
  "tasks": [
    { "agent": "reviewer", "task": "Review correctness." },
    { "agent": "tester", "task": "Suggest focused tests." }
  ]
}
```

Global agents live in `~/.pi/agent/agents/`. Project-local agents live in `.pi/agents/`.

## License

MIT. See `LICENSE`.
