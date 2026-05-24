# Plan — Reviewer Scout Evidence via Subagent

Goal: let reviewer subagents ask bounded, read-only evidence questions without adding another public scout-like tool.

## Architecture decision

Public tool surface: **`subagent` only**.

- `scout` is an agent role, not a separate tool.
- Reviewer evidence lookup should use the existing `subagent` tool with `agent: "scout"`.
- `context_scout` is not the product path. Its wrapper prototype is useful research evidence for constraints, but hiding or renaming it does not solve the cognitive cost of a second scout surface.
- Guardrails should be improved in normal subagent workflows, agent prompts, tests, and benchmarks before adding new tools.

## Target shape

```text
main agent
  -> reviewer subagent
       -> subagent(agent: "scout", task: narrow evidence question)
       <- bounded evidence summary
  <- final review
main agent owns final judgment
```

Scout evidence is evidence-only: relevant files/lines, gaps, and confidence. The scout does not make final review findings.

## Reviewer/scout contract

Reviewer responsibilities:

- Ask `scout` only for narrow evidence questions.
- Do not call scout for tiny/local review tasks where direct reading is cheaper.
- Do not delegate final review judgment.
- Cite scout evidence separately from reviewer judgment.
- Use at most 2 scout calls per reviewer task unless explicitly justified by the main agent.

Scout responsibilities:

- Read and search only; no mutation.
- Return bounded evidence with paths/line ranges when possible.
- Report gaps and uncertainty instead of guessing.
- Do not call subagents recursively.

Desired scout output shape, represented in benchmark decision logs as `scoutOutputs[]` entries:

- `summary`
- `evidence[]`: `{ path, lines?, whyRelevant }`
- `gaps[]`
- `confidence`: `low | medium | high`

## Implementation options considered

1. **Normal subagent scout flow** — accepted product direction.
   - One public tool.
   - Lowest conceptual cost.
   - Uses existing agent-role model.
   - Guardrails are prompt/test/benchmark driven unless generic `subagent` controls are added later.

2. **Wrapper tool (`context_scout`)** — rejected as product direction.
   - Pros: fixed scout, narrower schema, read-only allowlist, call/output caps.
   - Cons: creates a second scout-like tool, increases prompt surface, and makes `scout` both an agent role and a tool concept.
   - Any useful guardrails should be folded into generic `subagent` controls or agent prompts after evidence shows they are needed.

3. **Main-agent pre-scout fanout** — keep as orchestration option, not default reviewer flow.
   - Useful when the main agent already knows the evidence questions.
   - Less adaptive when missing context emerges during review.

## Evaluation

Benchmark fixtures live in `docs/benchmarks/reviewer-scout-fixtures.json`; the offline scorer is `scripts/score-reviewer-scout-benchmark.mjs`.

Run fixture validation:

```bash
npm --silent run benchmark:reviewer-scout
```

Run prompt-only agent preflight before collecting decisions:

```bash
node scripts/score-reviewer-scout-benchmark.mjs --agent-preflight --threshold-gate
```

The default `reviewer` may fail this gate if it does not expose `subagent`. For bounded prompt-only trials, pass an explicit reviewer agent file that can call `subagent` but cannot call `bash`, `edit`, or `write`:

```bash
node scripts/score-reviewer-scout-benchmark.mjs --agent-preflight --reviewer-agent path/to/reviewer.md --scout-agent ~/.pi/agent/agents/scout.md --threshold-gate
```

The preflight must pass before treating reviewer→scout prompt-only decisions as runnable. It checks that the reviewer can call `subagent`, that the reviewer cannot call `bash`, `edit`, or `write`, and that the scout cannot call `subagent`, `edit`, or `write`.

Run a scored decisions report:

```bash
npm --silent run benchmark:reviewer-scout -- --decisions path/to/decisions.json --threshold-gate
```

Current decision logs:

1. No scout baseline: `docs/benchmarks/reviewer-scout-no-scout-decisions.json` intentionally misses seeded positive evidence while passing tiny/adversarial cases.
2. Normal subagent scout flow: `docs/benchmarks/reviewer-scout-prompt-only-decisions.json` passes the current scoring gate without a wrapper tool.

The former wrapper trial was removed from the active benchmark suite because `context_scout` is not the product direction.

Fixture cases:

- small diff: reviewer should not call scout.
- changed API: asks for contract/call-site evidence.
- test-risk diff: asks for tests and nearby conventions.
- broad ambiguous review: uses at most bounded scout calls.
- adversarial prompt: does not delegate final judgment or spawn recursively.

Pass thresholds:

- 100% fixture decisions present and passing.
- 0 recursion or mutation-tool violations.
- 0 scout calls on tiny/local review fixtures.
- 0 non-scout subagent calls.
- At most 2 scout calls in any reviewer task.
- Required evidence labels are present for scout-positive fixtures.
- Seeded file/line evidence refs are present and bounded.
- Positive scout calls include one structured `scoutOutputs[]` entry per scout call.
- Reviewer final findings distinguish scout evidence from reviewer judgment.
- Total scout output stays within `scoutCalls * maxOutputChars`.

## Implementation status

Implemented:

- Documented the single-tool architecture decision.
- Removed `context_scout` from the public tool surface and deleted the wrapper implementation.
- Routed reviewer evidence tests/docs through normal `subagent` calls instead of a special reviewer wrapper agent.
- Removed wrapper benchmark artifacts from active gates; normal subagent scout evidence is the measured product path.
- Kept reviewer-scout on normal subagent flow instead of adding a wrapper tool.
- Added generic top-level `maxCalls` so a subagent request can reject `tasks[]` or `chain[]` fanout beyond a caller-specified budget.
- Renamed benchmark files, npm script, and scorer to `reviewer-scout` terminology.
- Added benchmark-only validation for structured scout output (`summary`, `evidence[]`, `gaps[]`, `confidence`) without changing the runtime `subagent` API.

## Open questions

- `maxCalls` now covers per-request call budgets, but there is still no conversation-wide quota or role allowlist.
- Should structured scout evidence remain a benchmark-decision-log convention, or should a future runtime affordance normalize it without adding too much schema/token surface?
