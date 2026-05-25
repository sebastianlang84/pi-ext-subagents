# Subagent routing automated run — 2026-05-25

## Run

Model: `openai-codex/gpt-5.5`

Decision file: [`subagent-routing-auto-2026-05-25-openai-codex-gpt-5-5.json`](subagent-routing-auto-2026-05-25-openai-codex-gpt-5-5.json)

Commands:

```bash
npm --silent run benchmark:subagent-routing
npm --silent run benchmark:subagent-routing -- \
  --decisions docs/benchmarks/subagent-routing-prompt-only-decisions.json \
  --threshold-gate
npm --silent run benchmark:subagent-routing:run -- \
  --model openai-codex/gpt-5.5 \
  --fixture P1,N1,S1,S4 \
  --output docs/benchmarks/subagent-routing-smoke-2026-05-25-openai-codex-gpt-5-5.json
node -e 'import("./scripts/score-subagent-routing-benchmark.mjs").then(({loadJsonFile,validateDecisionsDocument})=>validateDecisionsDocument(loadJsonFile(process.argv[1])))' \
  docs/benchmarks/subagent-routing-smoke-2026-05-25-openai-codex-gpt-5-5.json
npm --silent run benchmark:subagent-routing:run -- \
  --model openai-codex/gpt-5.5 \
  --output docs/benchmarks/subagent-routing-auto-2026-05-25-openai-codex-gpt-5-5.json
npm --silent run benchmark:subagent-routing -- \
  --decisions docs/benchmarks/subagent-routing-auto-2026-05-25-openai-codex-gpt-5-5.json \
  --threshold-gate
```

The smoke file validated runner output shape and was deleted instead of kept as a benchmark artifact.

Token-injection report: N/A. This run changed no prompt-facing metadata, schema text, or skill wording.

## Gate

Automated full run: **pass**.

Historical prompt-only drift check: expected non-zero gate failure, still caused by `metadata-skill` and `schema-affordance` positive pass-rate misses in [`subagent-routing-prompt-only-decisions.json`](subagent-routing-prompt-only-decisions.json).

## Summary

| Condition | Positive pass | Negative false positives | Schema-gravity false positives | Gate issue |
| --- | ---: | ---: | ---: | --- |
| metadata-only | 6/6 | 0/6 | 1/4 | none |
| metadata-skill | 6/6 | 0/6 | 0/4 | none |
| improved-metadata | 6/6 | 0/6 | 1/4 | none |
| schema-affordance | 6/6 | 0/6 | 0/4 | none |

## Misses

- `metadata-only` / `S2`: chose `parallel-then-synthesis` for a normal code review. Note: "Code review benefits from independent parallel review lanes, followed by main-agent synthesis and final judgment."
- `improved-metadata` / `S2`: chose `parallel-then-synthesis` for a normal code review. Note: "A normal code review of an unspecified diff is broad enough for independent lanes such as correctness, tests, security, and maintainability, followed by synthesis into the main agent’s final review judgment."

No positive fixtures missed. No negative-group false positives. `schema-affordance` did not create schema-gravity false positives in this run.

## Interpretation

This automated run is stronger than the historical hand-authored prompt-only baseline for positive recognition: all four conditions recognized all six fanout-then-synthesis positives.

The main concern moved from positive misses to ordinary-review overdelegation. `metadata-only` and `improved-metadata` treated `S2` as broad enough for parallel review plus synthesis. The `metadata-skill` and `schema-affordance` conditions stayed conservative on `S2`.

The run does not justify built-in reducer execution. It only shows that a visible schema-affordance can pass this routing benchmark once. API work is still blocked by the output-bounding, result-shape, display, token-budget, and partial-failure prerequisites in [`docs/plans/fanout-reduce.md`](../plans/fanout-reduce.md).

## Recommendation

- Keep fanout-then-reduce as a manual orchestration pattern for now.
- Do not prototype built-in `reduce` from this single automated run.
- Before prompt-facing changes, repeat the automated run and/or run an additional model to check whether `S2` overdelegation and schema-affordance success are stable.
- If results stay similar, prefer tightening compact metadata around normal review over adding API surface.
