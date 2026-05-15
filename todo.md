# TODO — Architektur-Deepening für pi-subagents

Stand: 2026-05-14
Status: Alle Architektur-Deepening-Todos aus dieser Datei sind umgesetzt und mit Tests abgesichert.

## Erledigt

- [x] **Subagent Run Module vertieft**
  - Run-/Lifecycle-Logik liegt in `src/run.ts`.
  - Abgesichert durch Fake-Prozess-Tests für partial JSON lines, malformed JSON diagnostics, `message_end`, `tool_result_end`, `agent_end` Grace/SIGTERM/SIGKILL, Spawn-Fehler, Abort und stderr-Capping.
  - Partial updates bleiben bis zum Child-Close als `exitCode: -1` sichtbar.

- [x] **Mode-Orchestration und Request-Normalisierung vertieft**
  - Rohparameter werden in `src/request.ts` zu einem validierten Execution Plan normalisiert.
  - Tests decken Single/Parallel/Chain, genau-ein-Modus-Regel, leere Tasks, whitespace-only Agent/Task/CWD, ungültiges `agentScope` und Max-Parallel-Grenze ab.

- [x] **Agent Catalog Module vertieft**
  - Discovery, Scope-Priorität, Frontmatter-Normalisierung und Project-Agent Trust-Policy liegen in `src/agents.ts`.
  - Tests decken user/project/both Scope, Project-overrides-User, malformed Frontmatter, YAML-list `tools`, Symlink-Akzeptanz und Trust-Entscheidung ab.

- [x] **Display Model Module vertieft**
  - Ergebnisdarstellung wird in `src/display.ts` zuerst in ein Display Model übersetzt; `src/index.ts` rendert nur noch dieses Modell.
  - Tests decken collapsed Single, expanded Chain, parallel running/warning/error/success states, `errorMessage` und `stopReason: "error"` trotz `exitCode: 0` ab.

- [x] **Package Entry Seam vereinheitlicht**
  - Gewählte Seam: einzelne Extension mit direktem Manifest-Eintrag `pi.extensions: ["./src/index.ts"]`.
  - Kein Root-`index.ts`-Shim im aktuellen Baum.
  - Manifest-/Entrypoint-Test prüft, dass `./src/index.ts` existiert.

- [x] **Test-Seams eingerichtet**
  - Test-Toolchain: `node --test tests/*.test.mjs` mit `jiti` für TypeScript-Quellen.
  - Testebenen: pure Request-Tests, Fake-Prozess Run-Tests, Fake-FS Agent-Catalog-Tests, Display-Model-Tests, Extension-/Manifest-Smoke-Tests.

## Dokumentierte Entscheidungen

- Project-local Agents laufen headless fail-closed, außer `confirmProjectAgents: false` wird für ein vertrautes Repo explizit gesetzt.
- Malformed JSON stdout events aus Subagent JSON mode werden ignoriert, damit spätere valide Events weiterlaufen; die Diagnose landet in `stderr`.
- Runtime-/Package-Struktur folgt aktuellem Pi Package Scope `@earendil-works/*` und direktem `src/index.ts` Entrypoint.

## Verifikation

- `npm test` — 26/26 Tests grün am 2026-05-14.
