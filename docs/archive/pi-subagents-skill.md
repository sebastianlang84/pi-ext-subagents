# Archived global pi-subagents skill

Archived on 2026-06-09 when `pi-subagents` v3.1.0 made the extension self-contained for normal subagent routing. This file is historical reference only; it is not installed as a Pi skill.

---

---
name: pi-subagents
description: "Use when Pi subagent orchestration needs more than the subagent tool's built-in prompt guidance: optional Dispatcher preflight, role selection, Scout→Worker→Verifier→Reviewer routing, optional risk Planner, local agent-file/tool/model checks, CodeMap availability, or review discipline. Do not use for tiny/local tasks where the tool metadata is sufficient."
---

# Pi Subagents

Use this skill for **Pi-specific** subagent orchestration policy. The `subagent` extension already injects compact always-on guidance for when to delegate, how to phrase delegated prompts, and when to use single/parallel/chain modes. Do not repeat that baseline unless a task needs the deeper rules below.

## Target role split

Optional preflight when route/scope is unclear:

```text
Dispatcher -> recommended minimal route
```

Default route for normal non-trivial implementation:

```text
Scout -> Worker -> Verifier -> Reviewer
```

Risky route, only when planning is justified:

```text
Scout -> Planner -> Worker -> Verifier -> Reviewer
```

Tiny obvious change:

```text
Orchestrator directly
```

Dispatcher is optional and should be skipped for tiny/clear work. Verifier is standard. Planner is optional. The main/orchestrator agent owns final judgment and the user-facing summary.

## When this skill adds value

Load this skill when you need one of these Pi-specific decisions:

- choosing among local roles (`dispatcher`, `scout`, `worker`, `verifier`, `reviewer`, `planner`)
- deciding whether optional `dispatcher` preflight or optional `planner` sequencing is justified
- handling `reviewer` blocked -> targeted `scout` -> `reviewer` final
- handling `verifier` fail -> back to `worker` -> `verifier` -> `reviewer`
- checking local agent files, declared tools, model routing, or project-agent trust
- controlling context budgets, CodeMap availability, or subagent crawl scope
- reviewing whether a subagent result satisfies the original user request

For tiny, clear, local tasks: do not delegate and do not load more subagent policy.

## Orchestration rules

- Main agent owns orchestration, final judgment, writes by default, and the user-facing summary.
- Prefer read-only subagents unless a bounded `worker` is explicitly useful.
- Avoid skill-token cascades: main may read workflow/reference skills, but subagents should not read additional skills unless the dispatch prompt explicitly says so.
- Do not use subagents as a default team simulation.
- `dispatcher` may be used only when the minimal route is unclear; it must stay shallow and recommend routing, scope volume, scout split, and per-scout budgets instead of scouting, planning, implementing, verifying, or reviewing.
- `scout` may be skipped only for a tiny change, an obvious one-file fix, or when the user already provides a complete diff/context.
- `planner` may be used only for multiple modules, API/data-model/migration work, auth/security, unclear sequencing, or high regression risk.
- `reviewer` may be used directly when the user provides an existing diff, plan, analysis, or asks only for review.
- Do not review after verifier failure unless the user explicitly requests review despite failure.

## Workflow choices

- Route/scope unclear before delegation: `dispatcher`, then follow its recommended minimal route.
- Context gathering only: `scout`.
- Normal implementation: `scout -> worker -> verifier -> reviewer`.
- Large, risky, cross-cutting, or ambiguous work: `scout -> planner -> worker -> verifier -> reviewer`.
- Reviewer blocked: take the exact Scout request, run `scout` in `targeted` mode, then return results to `reviewer` for final review.
- Verifier failed: return to `worker` for a bounded fix, rerun `verifier`, then run `reviewer` only after mechanical verification passes or the user asks otherwise.
- Lightweight independent checks: use up to 4 disjoint lanes when justified; prefer fewer if the split is weak.

## Local roles

- `dispatcher`: optional read-only preflight router. Sizes the current task, estimates scope volume/risk/context/tool budget, identifies whether one scout would be overloaded, and recommends the minimal route plus scout split. No deep scouting, planning, implementation, verification, review, or backlog prioritization.
- `scout`: read-only context scout. Finds relevant files, symbols, call sites, tests, types/interfaces, constraints/invariants, and candidate verification commands. Modes: `recon`, `targeted`, `bug-hunt`. No implementation, architecture planning, or review.
- `worker`: bounded implementation. Makes the minimal necessary diff from a scout brief or planner output, runs allowed checks when possible, and returns a Review Packet.
- `verifier`: mechanical verification. Runs only caller-listed build/test/typecheck/lint/repro commands and reports exit codes/logs. No implementation or semantic review.
- `reviewer`: semantic review. Checks the final diff against the original task, scout brief, Review Packet, Verification Report, and optional planner output. No tests or broad exploration.
- `planner`: optional risk planner. Produces a safe sequence only for migrations, API/data-model/auth/security changes, cross-cutting refactors, unclear sequencing, or high regression risk. If unnecessary, says: `No planning needed. Use scout brief directly.`

Mnemonic:

```text
Dispatcher: Welche minimale Route ist sicher?
Scout: Wo ist der relevante Kontext?
Worker: Was ändern wir?
Verifier: Läuft es?
Reviewer: Ist es richtig?
Planner: Brauchen wir bei Risiko eine sichere Sequenz?
```

## Handoff and budget discipline

- Give subagents only the task-specific policy they need; do not tell them to load broad skills by default.
- Include explicit scope, exclusions, allowed paths/tools, stop conditions, command/tool-call budget, and output shape.
- Default lightweight budget: up to 2 shallow tool calls and max 24 lines for dispatcher; up to 4 tool calls for a scout/reviewer, up to 2 CodeMap queries, max 25-40 output lines.
- Worker prompts must include the original task and scout/planner brief; verifier prompts must include the exact commands it may run; reviewer prompts must include original task, diff/context, Review Packet, Verification Report, and optional scout/planner output.
- Do not let subagents crawl broad home/system paths, session history, or unrelated repos unless explicitly in scope.
- Reviewer checks the original request, not only the worker brief, and reports concise severity-tagged findings.

## CodeMap / repo navigation tools

- Before dispatching a subagent for codebase work, check whether the target agent's `tools:` include `codemap_status`, `codemap_index`, `codemap_search`, or `codemap_context`; Pi extensions may not be exposed to subagents unless listed there.
- If CodeMap is available to the subagent, explicitly allow it in the dispatch prompt, ask it to run `codemap_status` first, and refresh with `codemap_index` only when mutation of the local search index is acceptable for the task.
- If CodeMap is not available to the subagent, use CodeMap in the main agent and pass compact findings, or fall back to bounded `rg`/`read` instructions.
- Keep `rg`/`read` for exact text, config, logs, and small local lookups; prefer CodeMap for semantic/symbol-oriented exploration.

## Local agent files

- Global subagents live at `~/.pi/agent/agents/<name>.md`.
- Project subagents live at `.pi/agents/<name>.md` and are repo-controlled prompts; use project scope only for trusted repos.
- Agent frontmatter must include `name` and `description`.
- `model` is passed as `--model` to a new Pi process.
- `tools` is a comma-separated string such as `tools: read, bash` or `tools: read, bash, codemap_status, codemap_index, codemap_search, codemap_context`; do not use YAML list syntax.
- Built-in tool names include `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`; extension tools must also be explicitly listed when an allowlist is used.
- Do not rely on unsupported frontmatter fields like `thinking` or `reasoning`.

## Provider/model routing

- Before dispatch, read the target agent file and verify its `model:`.
- Only dispatch OpenAI Codex OAuth-backed subagents: model must match `openai-codex/gpt-*`.
- Do not append reasoning suffixes such as `:high`, `:medium`, `:low`, `:minimal`, or `:xhigh` to subagent model strings unless explicitly requested for a one-off test.
- If no compliant agent exists, say so and do not dispatch.
- Preferred local routing:
  - `dispatcher`: `openai-codex/gpt-5.4-mini`
  - `scout`: `openai-codex/gpt-5.4-mini`
  - `worker`: `openai-codex/gpt-5.5`
  - `verifier`: `openai-codex/gpt-5.5`
  - `reviewer`: `openai-codex/gpt-5.5`
  - `planner`: `openai-codex/gpt-5.5`

## Anti-patterns

- Delegating tiny tasks.
- Making `dispatcher` mandatory or letting it deep-scout, plan, implement, verify, review, or choose backlog priorities.
- Letting `scout`, `planner`, `verifier`, or `reviewer` write code.
- Letting `verifier` invent or substitute commands.
- Reviewing after a failed verifier run without explicit user approval.
- Sending one overbroad scout when dispatcher or task shape indicates independent lanes should be split.
- Sending vague prompts without scope, budgets, and stop conditions.
- Skill cascades where a subagent reads multiple broad skills instead of receiving compact instructions.
- Treating worker output as final without verifier/reviewer or main-agent judgment.

## Dispatcher smoke checks

When changing dispatcher behavior, test the boundary cases before relying on it:

- tiny memory/TODO request -> `direct`
- unfamiliar auth/session schema migration -> `sequence: scout -> planner`
- read-only diagnosis across independent evidence lanes -> `parallel scouts` with named lanes and overload warning
- broad multi-area audit -> `parallel scouts`, or `sequence: parallel scouts -> planner` when a plan is requested; cap to 2-4 lanes, not one overbroad scout

If available, keep the detailed fixture/report in the subagent package benchmark docs; otherwise record the smoke prompts and observed routes in the change notes.
