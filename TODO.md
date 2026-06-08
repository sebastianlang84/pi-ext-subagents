# TODO — Active Backlog

Purpose: active open work only. Completed work belongs in `CHANGELOG.md`, git history, or release notes — not as checked-off TODO entries.

## P1 — Subagent result UX follow-up

1. [ ] Make subagent Scout Brief handoff structurally reliable.
   - Current mitigation: single-task parallel output is no longer framed as `Parallel`, and default previews preserve more of the brief.
   - Remaining question: should subagent results expose structured fields such as `brief`, `findings`, `artifacts`, and `truncated`, instead of only concatenated terminal-style text?
   - Expected: main agents can reliably extract and present the actual Scout Brief without the user having to ask “what is with scout brief?”.

2. [ ] Improve overlong-output recovery beyond storage-limit diagnostics.
   - Current mitigation: storage-only `[truncated after ... chars]` markers are replaced with recovery guidance, and oversized stored messages try to preserve a text prefix.
   - Remaining question: can overlong scout outputs produce a compact retained summary and explicit next action instead of only a diagnostic?
   - Add regression coverage for any future structured summary behavior across `outputMode=summary/full`, `maxOutputChars`, and overlong scout outputs.

## P2 — Optional fanout-then-reduce orchestration research

1. [ ] Explore optional fanout-then-reduce orchestration.
   - Canonical research plan: `docs/plans/fanout-reduce.md`.
   - Routing benchmark spec: `docs/plans/subagent-routing-benchmark.md`.
   - Evaluation execution plan: `docs/plans/subagent-routing-eval-plan.md`.
   - Existing run artifacts live under `docs/benchmarks/`; do not duplicate historical result details in this active backlog.
   - Next: repeat automated run and/or run another model before prompt-facing/API changes; do not prototype built-in `reduce` yet.
