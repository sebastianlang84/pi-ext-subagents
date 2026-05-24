# Single-subagent display cleanup plan

Status: implemented in v1.3.4. This document records the UX decision; it is not an API contract.

## Purpose

Reduce redundant TUI labels for a normal single `subagent` call while preserving the security and diagnostic information that matters for repo-local agents, parallel runs, and chains.

Observed example:

```text
subagent reviewer [global]
⏳ reviewer (global)

─── reviewer ⏳
```

This repeats the agent name three times and repeats `global` twice before any useful subagent output appears.

## Current baseline

The redundancy comes from three separate display layers:

1. **Call preview** — `src/index.ts` `renderCall()` shows the requested operation as `subagent <agent> [<agentScope>]`.
2. **Result header** — `src/display.ts` single-mode display model shows the resolved result as `<agent> (<agentSource>)`.
3. **Result section** — `src/display.ts` `resultSection()` uses the agent name again as the section heading, rendered by `src/index.ts` as `─── <agent> <status>`.

The two `global` labels have different sources:

- `[global]` is the requested `agentScope` after normalization.
- `(global)` is the resolved `agentSource` from the discovered agent config, set on `SingleResult` in `src/run.ts`.

For the common case of a single global agent, these two labels communicate the same fact to the user.

## UX contract

Final rule:

> Single = inline result. Parallel/Chain = sectioned result. Source is visible only when it adds information beyond the requested call scope.

### Single mode

Goal: show the agent at most once inside the result component, then show output/progress directly. During execution, Pi may still show both the call preview and the result component; the target therefore reduces the combined visible state from three `reviewer` labels to two, and the result body itself no longer repeats the agent as a section heading.

Recommended shape for running/collapsed single mode:

```text
subagent reviewer [global]

⏳ reviewer
→ read package.json
```

Recommended shape after completion:

```text
✓ reviewer
Looks good. No issues found.

1 turn ↑1.0k ↓25 $0.0100
```

Recommended expanded shape:

```text
✓ reviewer
Task: Review the current uncommitted changes.

→ read package.json
→ git diff

Looks good. No issues found.

1 turn ↑1.0k ↓25 $0.0100 ctx:1.0k model-a
```

Recommended shape on error:

```text
✗ reviewer
Error: subagent exploded
→ read package.json
```

Do not render a `─── reviewer` or `─── output` section heading for the ordinary single-result view. The result header is enough context, and direct items make the single case feel lightweight.

### Provenance display

Hide `(global)` for normal single global results because it duplicates the requested `[global]` call scope. Show provenance when it carries extra information or affects trust/debugging:

- resolved source is `repo`
- resolved source is `unknown`
- requested scope is `global+repo`, where the resolved source matters even if it is `global`
- an error/diagnostic case needs source clarity

Examples:

```text
✓ reviewer (repo)
Looks good. No issues found.
```

```text
✓ reviewer (repo via global+repo)
Looks good. No issues found.
```

```text
✗ reviewer (repo)
Error: subagent exploded
→ read package.json
```

### Parallel mode

Keep the existing mode header plus per-agent sections. In parallel runs, per-agent headings are useful because they separate independent outputs and statuses.

Example target:

```text
subagent parallel (3 tasks) [global]

⏳ parallel 1/3 done, 2 running

─── scout ⏳
→ rg display

─── reviewer ✓
No issues found.

─── oracle ⏳
(running...)
```

When provenance matters, show it in the section heading:

```text
◐ parallel 2/3 tasks

─── scout ✓
Found relevant display files.

─── reviewer (repo) ✗
Error: repo-local reviewer failed.

─── oracle ✓
No architectural blockers.
```

### Chain mode

Keep the existing mode header plus per-step sections. In chains, step identity is useful because outputs are ordered handoffs.

Example target:

```text
subagent chain (3 steps) [global]

⏳ chain 2/3 steps

─── Step 1: scout ✓
Found relevant files.

─── Step 2: worker ✓
Implemented minimal change.

─── Step 3: reviewer ⏳
→ git diff
```

When provenance matters, show it in the step heading:

```text
⏳ chain 2/3 steps

─── Step 1: scout ✓
Found relevant files.

─── Step 2: worker ✓
Implemented minimal change.

─── Step 3: reviewer (repo) ⏳
→ git diff
```

## Candidate implementation

Keep the implementation model-driven so the UX rule does not become scattered renderer special cases.

Recommended display-model shape:

```ts
ResultDisplaySection {
  presentation: "inline" | "section";
}
```

Mode mapping:

- `single` -> one `inline` section
- `parallel` -> `section` per agent
- `chain` -> `section` per step

Implementation guidance:

- Put layout/provenance decisions in `src/display.ts`, where `details.mode`, `details.agentScope`, and each `result.agentSource` are available.
- Keep `src/run.ts` as factual execution data only; do not add presentation policy there.
- Keep `src/index.ts` renderer simple: render inline sections directly under the header; render sectioned sections with `───` headings.
- Teach both TUI rendering and `stringifyResultDisplayModel()` the same model contract to avoid test/UI drift.
- Add a central helper such as `shouldShowResultSource(details, result)` and a formatter for source suffixes.
- `ResultDisplaySection.meta` is currently populated but not rendered/stringified; either make it part of the visible contract when provenance matters or remove/replace it with the new source-suffix model.

This keeps `single inline, parallel/chain sectioned` as an explicit layout concept rather than a collection of ad hoc `if single` branches.

## Open design questions

1. Should the call preview keep `[global]`? It is useful for trust/security, but the default may be noisy. A conservative first change should keep it.
2. Should expanded single mode also be inline? Preferred answer: yes, but expanded mode may add `Task:` and full usage metadata before/after the direct items.
3. Should collapsed single usage remain visible? Preferred answer: keep the existing dim usage line unless a later UX pass intentionally hides usage in collapsed views.

## Test plan

Update `tests/display.test.mjs` to encode the new UX contract:

- single global result has the intended concrete shape, e.g. `success reviewer` followed directly by items/final output, with no single-mode `## reviewer` and preferably no `## output`
- single global result does not show the default `(global)` suffix
- single repo, unknown, or ambiguous `global+repo` case exposes resolved source in the rendered/stringified output if we decide source is diagnostically important
- parallel display keeps per-agent headings
- chain display keeps per-step headings

Suggested commands:

```bash
node --test tests/display.test.mjs tests/extension.test.mjs
npm test
```

Manual smoke check after implementation:

```text
subagent reviewer [global]
```

The visible output should not repeat `reviewer` three times or `global` twice in the normal single global path.

## Non-goals

- Do not change subagent execution semantics.
- Do not change `agentScope` aliases or agent discovery.
- Do not remove provenance information for repo-local or ambiguous source cases.
- Do not redesign parallel/chain display unless required by the shared model changes.
