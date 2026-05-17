# Fanout-then-reduce orchestration research

Status: research / discussion draft. This document is not an API contract and does not commit the `subagent` tool to a `reduce` field.

## Purpose

Evaluate whether fanout-then-reduce should remain a prompt pattern or become built-in `subagent` tool behavior.

Fanout-then-reduce means:

1. Run independent subagent tasks in parallel.
2. Pass their outputs and diagnostics to one follow-up reducer subagent.
3. Use the reducer to synthesize, compare, decide, or produce a compact plan.

The reducer is another subagent run, not necessarily a new agent type. Existing agents such as `reviewer`, `planner`, or `oracle` may act as the reducer when their prompt is scoped for synthesis.

## Current baseline

The tool currently supports three modes:

- `single`: one agent/task
- `parallel`: independent task fanout with bounded concurrency
- `chain`: sequential handoffs using `{previous}`

Today, fanout-then-reduce can already be done manually with two calls:

1. Call `subagent` with `tasks` for independent lanes.
2. Call `subagent` again with a synthesis task containing the parallel outputs.

The research question is whether the tool should make this a first-class operation.

## Core problem: triggering, not mechanics

The hard part is not that a reducer prompt is impossible. A main agent can always write a one-off synthesis prompt after reading parallel outputs.

The hard part is that the main agent must first recognize that this workflow is appropriate. If fanout-then-reduce only lives in human documentation or chat history, agents will not reliably choose it. That makes the workflow dependent on ad-hoc prompt injection such as "use parallel agents and then synthesize with another agent".

So the design target is routing reliability:

- What agent-facing context makes the main agent choose this pattern without being explicitly told each time?
- Is compact tool metadata enough, or does it require a skill such as `subagent-workflow`?
- Would a first-class `reduce` field make the affordance visible enough to change behavior?
- Can we measure this with prompt-routing fixtures before adding API surface?

A built-in reducer only matters if it improves this recognition/reliability problem, not merely because it can automate a second subagent call.

## Research axis: tool affordance vs skill

A key hypothesis is that better `subagent` tool metadata may make part of the `subagent-workflow` skill unnecessary.

Ideal outcome:

- Tool description/schema/guidelines provide enough always-visible affordance for common routing decisions.
- The skill shrinks to deeper policy, edge cases, review discipline, and agent-file maintenance.
- Agents do not need a user prompt injection or skill load just to discover the fanout-then-reduce pattern.

This must be measured, not assumed. The canonical fixture set, compared conditions, scoring, and thresholds live in `docs/plans/subagent-routing-benchmark.md`.

Success means agents choose the right orchestration without overdelegating tiny tasks and without requiring explicit user wording such as "use fanout-then-reduce". Schema visibility can create useful affordance, but it can also create schema gravity: agents may choose `reduce` simply because the field exists. Benchmarks must therefore measure both positive routing and false positives.

## Why this may be useful

Fanout-then-reduce is useful when the first phase benefits from isolated perspectives but the final answer needs one coherent judgment. In interactive use, the main agent can often do this with two manual tool calls. The stronger case for built-in support is headless/API orchestration:

- one atomic operation instead of relying on main-agent discipline
- uniform failure semantics and replayable/testable behavior
- clearer progress/display UX for a two-phase workflow
- structured result details for downstream callers

Examples:

- scout relevant files + review risks + suggest tests, then synthesize an implementation plan
- compare multiple solution strategies, then pick the safest option
- run independent read-only audits, then produce one release-readiness verdict
- gather project facts and policy constraints in parallel, then compress them into a worker brief

## Candidate prompt pattern

Preferred near-term pattern:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find relevant files, constraints, and uncertainty. Return a compact brief." },
    { "agent": "reviewer", "task": "Find correctness, security, and maintenance risks. Return must-fix vs optional." }
  ]
}
```

Then run a reducer manually:

```json
{
  "agent": "planner",
  "task": "Synthesize the parallel results below into a bounded plan. Preserve disagreements and list open decisions.\n\n<parallel-results>\n...\n</parallel-results>"
}
```

This avoids new schema surface while testing whether the workflow is common and reliable enough to deserve implementation.

## Candidate built-in shape

If evidence justifies built-in support, prefer the smallest API surface:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find relevant files." },
    { "agent": "reviewer", "task": "Find risks." }
  ],
  "reduce": {
    "agent": "planner",
    "task": "Synthesize these parallel results:\n{parallel}"
  }
}
```

Exploratory constraints:

- `reduce` is only valid with `tasks`.
- `reduce.task` should contain `{parallel}` so the insertion point is explicit.
- Existing `single`, `parallel`, and `chain` requests stay unchanged.
- The tool keeps bounded fanout concurrency.
- Built-in `reduce` must not ship before fanout outputs are reliably bounded and structured.
- The reducer receives a bounded, structured summary, not unbounded raw transcript dumps.

## Error semantics to preserve

Recent behavior treats partial parallel failures as tool errors while preserving successful outputs. Fanout-then-reduce must not weaken that contract.

Recommended semantics if implemented:

| Fanout result | Reducer result | Overall result |
| --- | --- | --- |
| all succeeded | succeeded | success |
| partial failure with at least one usable result | succeeded | error, with reducer output preserved |
| all succeeded or partial failure with usable result | failed | error, with fanout diagnostics preserved |
| all failed | not run | error |
| aborted | not run or aborted | error |

Preferred research hypothesis: run the reducer after partial fanout failure only when at least one usable result exists. Pass both successes and failure diagnostics to the reducer, but keep the overall tool result as `isError: true`. If the reducer succeeds after partial fanout failure, expose the reducer result separately while preserving the overall error state.

## Result shape hypothesis

Do not overload `details.results` for a two-phase workflow. If built-in `reduce` is implemented, prefer an explicit shape such as:

```ts
details: {
  orchestration: "parallel-reduce";
  fanout: { results: SingleResult[]; failures: SingleResult[] };
  reduce?: { result?: SingleResult; failure?: SingleResult };
}
```

Exact typing may differ, but the API should make fanout and reducer phases separately inspectable for display, tests, and headless callers.

## Risks and constraints

- **Prompt-facing token budget:** the registered tool currently has little budget headroom. Adding schema descriptions or guidelines may violate `npm run check:token-injection`.
- **Output growth:** fanout outputs can be large. Built-in `reduce` should be blocked until output bounding such as `maxOutputChars` or `outputMode` exists or an equivalent bounded structured fanout summary is specified.
- **Process argv exposure/limits:** prompts are currently passed to the child process as CLI arguments. Built-in reduce could worsen argv length and visibility until prompt transport changes.
- **Prompt injection:** reducer prompts include subagent outputs. The formatter must clearly delimit outputs and tell the reducer to treat them as data, not instructions.
- **Result shape:** callers need to know whether `details.results` contains only fanout results, the reducer result, or both.
- **Display UX:** progress and final display need to make the two phases obvious without hiding partial failures.

## Research questions

1. Do agents reliably choose the manual two-call pattern when the user asks for multi-perspective research plus synthesis but does not explicitly name fanout-then-reduce?
2. Which context surface causes the choice: tool metadata, `subagent-workflow`, a new skill, or a first-class `reduce` schema?
3. Can improved tool metadata replace or shrink the `subagent-workflow` skill for common routing decisions?
4. Does better tool affordance cause overdelegation on tiny or linear tasks?
5. If a `reduce` schema is visible, how often do agents choose it incorrectly because of schema gravity?
6. Is the value mostly interactive convenience, or does headless/API use need one atomic tool call?
7. What reducer input format is safest and most useful: text summary, structured JSON-ish blocks, full outputs, or truncated outputs?
8. Should reducer output replace the parallel summary, or should the final response include both summary and synthesis?
9. Does a minimal `reduce` schema fit the token-injection budget without weakening existing guidance?

## Acceptance criteria for implementation

Do not implement built-in `reduce` until the hard prerequisites are met:

- Fanout outputs are reliably bounded and structured before entering a reducer prompt.
- Partial-failure, all-failed, reducer-failed, and abort semantics are specified and covered by tests.
- `details` and display behavior are specified before coding, with separate fanout and reducer phase data.
- Any improved metadata or minimal schema includes an `npm run check:token-injection` report and justifies prompt-facing token growth; use explicit `--max-*-tokens` thresholds only when the benchmark run defines them.
- The feature remains backward-compatible with existing modes.

Routing benchmark thresholds before implementation are defined in `docs/plans/subagent-routing-benchmark.md` and must include positive-fixture accuracy, negative-fixture false positives, metadata-vs-skill comparison, schema-gravity false-positive delta, and token-budget checks.

Additional acceptance:

- Manual prompt-pattern usage proves common or unreliable enough to justify tool support.
- Prompt-injection boundaries are documented or tested.
- Error semantics are not materially more complex than existing `parallel` semantics plus a clearly separate reducer phase.

## Proposed next steps

1. Keep this document as the canonical discussion plan.
2. Use `docs/plans/subagent-routing-benchmark.md` to run prompt-routing fixtures where the task implies multi-perspective synthesis but does not explicitly mention fanout-then-reduce.
3. Use the benchmark results to decide whether the skill should be kept, shrunk, or made obsolete for common routing.
4. Try the manual pattern on real repo tasks and record failure modes.
5. Implement/enforce output controls (`maxOutputChars`, `outputMode`, or equivalent bounded summaries) before any built-in `reduce` prototype.
6. Revisit built-in `reduce` only after the routing benchmark and output-bounding prerequisite are satisfied.
