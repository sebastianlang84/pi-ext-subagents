# Subagent routing evaluation plan

Status: execution plan for the next fanout-then-reduce research step. This is not an API contract and does not approve a built-in `reduce` field.

## Goal

Collect repeatable automated evidence for whether Pi agents choose the right `subagent` orchestration from prompt-facing context alone, especially whether they recognize broad independent-lane work that needs synthesis without overdelegating tiny or linear tasks.

The decision this evaluation supports:

- keep fanout-then-reduce as a manual prompt pattern,
- improve compact tool metadata,
- shrink or retain the `pi-subagents` skill for routing guidance, or
- later consider a first-class non-executing/then executing `reduce` affordance after output-bounding prerequisites are met.

## Inputs and baseline

Canonical sources:

- Feature research context: [`docs/plans/fanout-reduce.md`](fanout-reduce.md)
- Benchmark spec and thresholds: [`docs/plans/subagent-routing-benchmark.md`](subagent-routing-benchmark.md)
- Fixtures: [`docs/benchmarks/subagent-routing-fixtures.json`](../benchmarks/subagent-routing-fixtures.json)
- Existing prompt-only baseline: [`docs/benchmarks/subagent-routing-prompt-only-decisions.json`](../benchmarks/subagent-routing-prompt-only-decisions.json)

Current provisional evidence from the prompt-only baseline:

- `metadata-only`: passed positives and avoided negative/schema-gravity false positives.
- `improved-metadata`: passed positives and avoided negative/schema-gravity false positives.
- `metadata-skill`: missed positive fixtures `P2` and `P4`.
- `schema-affordance`: missed positive fixture `P4` without creating schema-gravity false positives.

Treat that baseline as provisional because it was not collected through the automated runner.

## Frozen evaluation

Do not edit fixtures, expected labels, scorer thresholds, or condition definitions during an experiment that changes prompt-facing metadata, skill wording, or schema affordance. If the benchmark itself needs correction, make that a separate benchmark-maintenance change and rerun the baseline.

Primary metrics are the existing scorer outputs:

- positive pass/acceptable rate,
- negative false-positive rate,
- schema-gravity false-positive delta,
- improved-metadata positive-rate delta from `metadata-skill`.

Thresholds remain owned by `docs/benchmarks/subagent-routing-fixtures.json` and interpreted by `scripts/score-subagent-routing-benchmark.mjs`.

## Guardrails

- Do not prototype or implement built-in `reduce` as part of this evaluation.
- Do not commit exploratory automated decision logs unless they are being kept as the benchmark record for discussion.
- Do not optimize by weakening fixtures or expected answers after seeing results.
- Change only one lever per follow-up experiment.
- If prompt-facing metadata, schema text, or skill wording changes, run `npm run check:token-injection` and record the token-growth rationale.
- Preserve the output-bounding gate from `fanout-reduce.md`: reducer execution is out of scope until fanout outputs have a deterministic bounded/structured input shape.

## Experiment 0 — sanity checks

Purpose: prove the benchmark harness still runs before spending model calls.

Commands:

```bash
npm --silent run benchmark:subagent-routing
npm --silent run benchmark:subagent-routing -- \
  --decisions docs/benchmarks/subagent-routing-prompt-only-decisions.json \
  --threshold-gate
```

Expected result:

- fixture validation succeeds;
- the historical prompt-only decision file still produces the documented gate result, which is currently a non-zero threshold-gate failure because `metadata-skill` and `schema-affordance` miss positive fixtures.

Treat this as a drift check: the exact gate issues should match `subagent-routing-benchmark.md`. If the failure shape changes unexpectedly, fix documentation/scorer drift before collecting new decisions.

## Experiment 1 — automated runner smoke

Purpose: verify Pi print-mode JSON extraction, model access, timeout, and output parsing before a full run.

Run a minimal fixture spread with one positive, one tiny negative, one schema-gravity, and one dependent-chain case:

```bash
npm --silent run benchmark:subagent-routing:run -- \
  --model <model> \
  --fixture P1,N1,S1,S4 \
  --output docs/benchmarks/subagent-routing-smoke-<date>-<model-slug>.json

node -e 'import("./scripts/score-subagent-routing-benchmark.mjs").then(({loadJsonFile,validateDecisionsDocument})=>validateDecisionsDocument(loadJsonFile(process.argv[1])))' \
  docs/benchmarks/subagent-routing-smoke-<date>-<model-slug>.json
```

Do not use the full scorer to interpret a partial smoke file as a benchmark result; the scorer expects every fixture and will mark omitted fixtures as missing decisions. Review only runner/parsing failures manually before proceeding. Delete or leave untracked smoke logs unless they reveal a harness problem worth documenting.

## Experiment 2 — automated full run

Purpose: collect the first repeatable automated evidence across all current conditions.

```bash
npm --silent run benchmark:subagent-routing:run -- \
  --model <model> \
  --output docs/benchmarks/subagent-routing-auto-<date>-<model-slug>.json

npm --silent run benchmark:subagent-routing -- \
  --decisions docs/benchmarks/subagent-routing-auto-<date>-<model-slug>.json \
  --threshold-gate
```

Record:

- command and model,
- generated decision file path,
- threshold-gate pass/fail,
- per-condition misses by fixture id,
- notable rationale patterns in `notes`, especially P2/P4 and schema-gravity cases.

## Experiment 3 — optional additional model run

Run only if Experiment 2 is inconclusive, surprising, or intended to justify prompt-facing/API changes.

Use the same commands and fixtures with another relevant model. Compare only against the frozen evaluation, not against manually adjusted expectations.

## Follow-up experiments, one lever at a time

Only after at least one full automated run:

1. **Metadata wording variant** — minimal prompt-facing wording to improve broad independent-lane + synthesis recognition. Run token-injection check and the full benchmark.
2. **Skill wording variant** — adjust `pi-subagents` routing guidance if it remains more conservative than metadata on positives. Run the full benchmark.
3. **Schema-affordance variant** — continue as non-executing routing measurement only. Do not add runtime behavior until output-bounding and result/error semantics are specified and tested.

Do not combine metadata, skill, and schema changes in one experiment.

## Decision rules

- Keep built-in `reduce` deferred unless schema-affordance meets the positive threshold, stays within the schema-gravity false-positive delta, and improves over metadata-only by at least one positive fixture or repeats the same threshold-passing behavior across another model/run.
- Even with passing schema-affordance routing, API work remains deferred until the acceptance criteria in `fanout-reduce.md` are met, including bounded reducer input, partial-failure semantics, result shape, display behavior, and token-budget checks.
- Prefer metadata improvement over API surface when metadata reaches thresholds with acceptable token growth and no manual safety regression.
- Keep or refine `pi-subagents` if it adds useful discipline without suppressing valid broad fanout+synthesis cases.
- Shrink the skill only if compact metadata is within the configured delta of skill behavior and manual review finds no safety regression.
- Stop and redesign the benchmark if repeated runs of the same model disagree on any threshold-changing fixture or if notes show the model is guessing from benchmark wording rather than task shape.

## Result log format

For each kept automated run, add either a short section to `subagent-routing-benchmark.md` or a dated benchmark report under `docs/benchmarks/` with this shape:

```text
Run:
Model:
Command:
Decision file:
Gate:
Positive misses:
Negative false positives:
Schema-gravity false positives:
Token-injection report, if applicable:
Interpretation:
Recommendation:
```

## Review checklist before acting on results

- Were fixtures and thresholds unchanged during the run?
- Was the decision file produced by the automated runner rather than hand-authored?
- Did every condition run the same fixture set?
- Are failures classified by fixture id and condition?
- Are schema-gravity false positives separated from normal negative false positives?
- Is any proposed metadata/schema/skill change justified by measured deltas and token budget?
- Is built-in reducer execution still blocked until bounded reducer input and error/result semantics are specified?
