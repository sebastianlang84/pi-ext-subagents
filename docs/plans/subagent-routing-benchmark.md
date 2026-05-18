# Subagent routing benchmark spec

Status: benchmark design draft. This document defines how to evaluate subagent orchestration choices and points to the initial offline scorer; it does not approve a built-in `reduce` API.

## Purpose

Measure whether agents choose appropriate `subagent` orchestration from available context alone, especially whether they recognize fanout-then-reduce opportunities without explicit user wording.

The benchmark should answer:

- Can current tool metadata trigger good common routing without loading `pi-subagents`?
- Does `pi-subagents` materially improve routing decisions?
- Can minimal improved tool metadata shrink or replace the skill for common cases?
- Would a visible `reduce` schema improve recognition or create schema-gravity false positives?

## Non-goals

- No code implementation of built-in `reduce`.
- No model-provider comparison unless needed later.
- No evaluation of subagent answer quality after execution; this spec evaluates orchestration choice.
- No automatic model execution yet; the initial harness scores decision files produced by a human or separate runner.

## Compared conditions

Run the same fixture set under these context conditions:

1. **Tool metadata only** — current `subagent` tool description, schema, snippet, and guidelines.
2. **Tool metadata + `pi-subagents`** — same task, with the skill loaded before decision.
3. **Improved tool metadata** — minimal wording that mentions synthesis after independent parallel lanes, still passing `npm run check:token-injection`.
4. **Schema affordance prototype** — hypothetical visible `reduce` field or schema description, only for routing measurement; not an implementation commitment.

## Fixture rules

Fixtures must not reveal the expected orchestration in their wording. Avoid words such as `fanout`, `reduce`, `reducer`, or "use subagents" unless the fixture is explicitly testing user-directed behavior.

Each fixture records:

- user prompt
- expected orchestration
- acceptable alternatives
- disallowed choices
- scoring notes

The initial machine-readable fixture file is `docs/benchmarks/subagent-routing-fixtures.json`.

## Positive fixtures

These should trigger independent lanes plus synthesis, usually `parallel` followed by a reducer/synthesis step.

| ID | User prompt shape | Expected | Disallowed |
| --- | --- | --- | --- |
| P1 | "Research this feature from multiple angles and produce a plan we can discuss." | parallel research lanes, then synthesis | single local answer only |
| P2 | "Assess implementation options, risks, and test strategy for this change." | independent option/risk/test lanes, then synthesis | chain-only unless dependencies are justified |
| P3 | "Audit release readiness from independent perspectives and give one verdict." | parallel review lanes, then reducer verdict | only one reviewer when multiple perspectives are implied |
| P4 | "Compare architecture tradeoffs and recommend the safest next move." | multiple perspective checks plus synthesis | immediate implementation |
| P5 | "Investigate a cross-cutting bug with likely code, docs, and test implications." | parallel scouts/reviewers if scope is broad, then compact plan | broad unbounded crawl by main agent |

## Negative fixtures

These should not trigger fanout-then-reduce. Some should not delegate at all.

| ID | User prompt shape | Expected | Disallowed |
| --- | --- | --- | --- |
| N1 | "Fix this typo in README." | no subagent | any parallel/reducer use |
| N2 | "Read TODO.md and tell me the next item." | no subagent or one local read | any reducer use |
| N3 | "Explain what this function does." | no subagent unless file is large/unknown | parallel by default |
| N4 | "Run the existing tests and summarize failures." | direct command or one bounded check | multi-agent fanout |
| N5 | "Make this small linear code change." | main agent or scout→worker only if uncertainty exists | fanout-then-reduce |

## Schema-gravity fixtures

These are negative or borderline tasks used when a visible `reduce` field exists. They measure whether schema visibility causes unnecessary reducer use.

| ID | User prompt shape | Expected | Failure mode |
| --- | --- | --- | --- |
| S1 | "Give a concise answer based on this one file." | no reduce | chooses reduce because schema exists |
| S2 | "Do a normal code review of this diff." | one reviewer or main review | unnecessary parallel+reduce |
| S3 | "Summarize these two short notes." | main synthesis | reducer call despite trivial input |
| S4 | "Perform dependent steps A then B." | chain | parallel+reduce instead of chain |

## Output-bounding gate

Built-in `reduce` must not be prototyped for execution until fanout output entering the reducer is reliably bounded and structured.

Acceptable prerequisites:

- `maxOutputChars`, `outputMode`, or equivalent per-task output controls are implemented and enforced; or
- the reduce formatter uses a deterministic bounded summary that cannot include unbounded raw transcripts.

The routing benchmark may evaluate schema visibility before this gate, but only as a non-executing affordance test.

## Scoring dimensions

Score each fixture per condition:

- **Correct orchestration** — chooses no delegation, single, parallel, chain, or parallel-then-reducer appropriately.
- **Reducer recognition** — for positive fixtures, explicitly plans a synthesis/reducer phase after independent lanes.
- **Non-overdelegation** — avoids subagents for tiny/local tasks.
- **Mode fit** — uses parallel for independent lanes and chain for dependent handoffs.
- **Schema-gravity false positive** — chooses `reduce` mainly because it is visible.
- **Safety discipline** — preserves main-agent final judgment and does not implement before research when asked for planning. The initial scorer only type-checks `mainFinalJudgment`; this dimension remains a manual review field until a stricter rubric is defined.

Suggested result labels:

- `pass` — expected orchestration chosen.
- `acceptable` — different orchestration but justified and safe.
- `fail` — misses required orchestration or overdelegates.
- `schema-gravity-fail` — false-positive reducer use under schema affordance.

## Pass thresholds

Before shrinking `pi-subagents` or adding built-in `reduce`, require:

- Positive fixtures: at least 85% `pass` or `acceptable` with explicit reducer/synthesis recognition where expected.
- Negative fixtures: at most 15% overdelegation or incorrect reducer use.
- Improved tool metadata: within 5 percentage points of `pi-subagents` on positive fixtures to justify shrinking the skill.
- Schema affordance: false positives no more than 5 percentage points above metadata-only routing.
- Token budget: improved metadata or schema changes must include an `npm run check:token-injection` report and justify any prompt-facing token growth; use explicit `--max-*-tokens` thresholds only when the benchmark run defines them.

If thresholds fail:

- Keep or strengthen `pi-subagents` when the skill outperforms metadata.
- Avoid adding `reduce` schema if schema-gravity false positives exceed the threshold.
- Prefer benchmark-driven metadata edits before API changes.

## Offline scorer

The initial executable layer is an offline scorer, not a model runner. Without decisions it validates the fixture file and prints a summary:

```bash
npm --silent run benchmark:subagent-routing
```

With decisions it scores the run and can enforce thresholds:

```bash
npm --silent run benchmark:subagent-routing -- --decisions path/to/decisions.json --threshold-gate
```

Decision files use this shape:

```json
{
  "runs": [
    {
      "condition": "metadata-only",
      "model": "example-model",
      "decisions": [
        {
          "fixtureId": "P1",
          "orchestration": "parallel-then-synthesis",
          "synthesisPhase": true,
          "mainFinalJudgment": true,
          "notes": "parallel scouts plus planner synthesis"
        }
      ]
    }
  ]
}
```

Valid `orchestration` values are `none`, `single`, `parallel`, `chain`, and `parallel-then-synthesis`.

The scorer is `scripts/score-subagent-routing-benchmark.mjs`. It prints a JSON report and exits non-zero with `--threshold-gate` when thresholds fail.

The current scorer aggregates:

- positive pass/acceptable rate
- negative false-positive rate
- schema-gravity false-positive delta

Manual benchmark reports should also include:

- token-injection report and growth justification for any metadata/schema variant
- recommendation: keep skill, shrink skill, improve metadata, or consider built-in schema later

## Relationship to fanout-then-reduce

`docs/plans/fanout-reduce.md` owns the feature decision and output-bounding prerequisite. This document owns the routing benchmark fixtures, scoring, and thresholds.
