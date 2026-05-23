# Plan — Reviewer Context Scout

Goal: let a reviewer subagent ask bounded, read-only context questions without turning review into recursive agent fanout.

## Target shape

```text
main agent
  -> reviewer subagent
       -> context_scout(question, scope, budget)
       <- evidence packet
  <- final review
main agent owns final judgment
```

`context_scout` is evidence-only. It returns relevant files/lines, gaps, and confidence; it does not make final review findings.

## Proposed contract

Inputs:

- `question`: narrow, review-specific context question.
- `scope`: optional changed files, paths, symbols, or cwd.
- `budget`: max queries/files/output chars.

Initial budget defaults:

- `maxScoutCalls`: 2 per reviewer task.
- `maxQueries`: 3 per scout call.
- `maxFiles`: 5 per scout call.
- `maxOutputChars`: 4000 per scout call.

Do not add `mode` initially; start with `question + scope + budget` and add categorization only if benchmark results justify the extra schema surface.

Output:

- `summary`
- `evidence[]`: `{ path, lines?, whyRelevant }`
- `gaps[]`
- `confidence`: `low | medium | high`

## Guardrails

- Read-only scout execution.
- No scout-to-scout recursion.
- Prompt-only baseline can measure violations but cannot enforce them.
- For prompt-only trials, the configured scout agent must not expose `subagent`, `edit`, or `write` tools.
- Wrapper implementation must enforce `maxScoutCalls`, output caps, fixed scout allowlist, and no nested scout calls.
- Scout answers the reviewer directly; no side channel to the main agent.
- Reviewer must cite scout evidence separately from its own judgment.
- Keep prompt/tool text compact; no broad workflow injection.

## Implementation options

1. **Prompt-only baseline**: reviewer uses existing `subagent` tool to call a `scout` agent with strict instructions.
   - Lowest code cost.
   - Can only measure read-only/recursion/call-cap violations, not prevent them.
   - Feasibility gate: reviewer may call only `scout`; scout agent must not have `subagent` or mutation tools.

2. **Wrapper tool**: add a compact `context_scout` tool that internally runs the configured scout agent with fixed budgets and evidence-only output.
   - Cleaner reviewer UX and safer contract.
   - Must be opt-in/disabled by default unless tool exposure can be scoped to reviewer agents or the token cost is proven acceptable.
   - Do not implement if it would become unavoidable prompt-facing surface for all agents without measured benefit.

3. **Orchestrator fanout**: main agent launches scout(s) before reviewer.
   - Simple responsibility model.
   - Less adaptive because missing context is discovered during review.

Preferred research path: test option 1 with routing/eval fixtures; implement option 2 only if it measurably reduces bad delegation or review misses.

## Evaluation

Benchmark fixtures live in `docs/benchmarks/reviewer-context-scout-fixtures.json`; the offline scorer is `scripts/score-reviewer-context-scout-benchmark.mjs`.

Run fixture validation:

```bash
npm --silent run benchmark:reviewer-context-scout
```

Run a scored decisions report:

```bash
npm --silent run benchmark:reviewer-context-scout -- --decisions path/to/decisions.json --threshold-gate
```

Compare conditions:

1. no scout available.
2. prompt-only scout via existing `subagent`.
3. wrapper `context_scout`, only if the prompt-only baseline shows useful signal and unacceptable guardrail misses.

Fixture cases:

- small diff: reviewer should not call scout.
- changed API: asks for contract/call-site evidence.
- test-risk diff: asks for tests and nearby conventions.
- broad ambiguous review: uses at most bounded scout calls.
- adversarial prompt: does not delegate final judgment or spawn recursively.

Initial first-slice pass thresholds:

- 100% fixture decisions present and passing.
- 0 recursion or mutation-tool violations.
- 0 scout calls on tiny/local review fixtures.
- At most 2 scout calls in any reviewer task.
- Required evidence labels are present for scout-positive fixtures.
- Reviewer final findings distinguish scout evidence from reviewer judgment.
- Total scout output stays within `scoutCalls * maxOutputChars`.

Later seeded-evidence expansion:

- Add fixture-local file/line expectations so evidence relevance cannot pass by echoing labels only.
- Score whether cited evidence catches seeded review misses versus the no-scout baseline.

Metrics:

- correct scout-use decision
- seeded review-miss detection versus no-scout baseline after seeded-evidence fixtures exist
- evidence-label relevance first, then cited file/line relevance
- false-positive delegation rate
- output size
- recursion/overreach violations

## Open questions

- Can Pi/tool access be scoped enough that only reviewer agents see `context_scout`?
- If not, is an opt-in wrapper with added prompt surface still worth it?
- Should the scout agent be fixed (`scout`) or selectable from a small allowlist?
- How should evidence packets expose file line ranges without encouraging over-reading?
