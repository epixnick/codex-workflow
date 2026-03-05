# codex-workflow

Dieses Repo enthält ein lauffähiges Bootstrap für einen story-basierten Dev-Workflow mit Orchestrator, Agent-Rollen, Verification und PR-Publishing.

Der zentrale Einstiegspunkt ist:

- `.codex-workflow/scripts/orchestrator.js`

## Ziel

Der Workflow soll eine Story automatisch durch folgende Phasen bewegen:

1. Planning
2. Plan Review
3. Implementation
4. Diff Review
5. Verification
6. Publish (Commit, Push, PR, Required Checks)

Alles ist über `.codex-workflow/config.yaml` steuerbar.

## Quick Installation (einfach)

Voraussetzungen:

- Node.js 18+
- git
- gh (GitHub CLI)
- codex CLI
- `origin/main` existiert im Repo

### 1) Falls nötig: Workflow-Ordner ins Repo kopieren

```bash
cp -R /pfad/zu/codex-workflow/.codex-workflow /pfad/zu/deinem-repo/
cd /pfad/zu/deinem-repo
mkdir -p .codex-workflow/runs
touch .codex-workflow/runs/.gitkeep
```

### 2) Einmal Auth anmelden

```bash
codex login
codex login status
gh auth status
```

### 3) Story anlegen (nur Datei, kein YAML-Eintrag)

Lege eine Datei an:

- `.codex-workflow/input/{id}-{slug}.md`
- Beispiel: `.codex-workflow/input/001-auth-refactor.md`

Namensregeln:

- `id` numerisch (`001`, `002`, `003`, ...)
- `slug` lowercase-kebab-case
- Dateiname exakt `{id}-{slug}.md`

Optional für Abhängigkeiten:

```md
---
depends_on:
  - "001"
---
# Story 002: Auth Refactor
```

### 4) Workflow starten

```bash
node .codex-workflow/scripts/orchestrator.js
```

Optional mit detaillierten Logs (inkl. Agent-Calls):

```bash
node .codex-workflow/scripts/orchestrator.js --verbose
```

Das war's. Der Orchestrator:

- synchronisiert `stories.yaml` automatisch aus `input/` (rekursiv)
- ignoriert `input/archiv/`
- verarbeitet die nächste aktive Story

Mit `--verbose` siehst du zusätzlich die ausführliche Ausgabe der internen `codex exec`-Aufrufe im Terminal.

### 5) Story archivieren

Wenn eine Story nicht mehr aktiv sein soll:

```bash
mkdir -p .codex-workflow/input/archiv
mv .codex-workflow/input/001-auth-refactor.md .codex-workflow/input/archiv/
```

Beim nächsten Run wird sie nicht mehr in `stories.yaml` geführt.

### 6) Wichtig für Verification

`verification_commands` in `.codex-workflow/config.yaml` müssen zu deinem Projekt passen.

## Repo-Struktur

```text
.codex-workflow/
  config.yaml
  stories.yaml
  input/
  runs/
  templates/
  scripts/
    orchestrator.js
    validator.js
    git-helpers.sh
```

Kurzer Zweck je Datei:

- `config.yaml`: globales Verhalten (Modelle, Transport, Verification, Timeouts, Branching, PR, Checks)
- `stories.yaml`: vom Orchestrator generierte Spiegeldatei der aktiven Inputs
- `input/{id}-{slug}.md`: Story-Input
- `runs/{id}-{slug}/`: Run-Artefakte und Logs
- `templates/*.tpl`: machine-readable Ausgabeformate je Phase
- `orchestrator.js`: state machine und Loop-Koordination
- `validator.js`: validiert Plan-/Review-Artefakte
- `git-helpers.sh`: git/gh-Helfer

## End-to-End Ablauf

`orchestrator.js` macht pro Story (vereinfacht):

1. `loadConfig()`
2. synchronisiert `stories.yaml` aus `input/` (rekursiv, ohne `input/archiv/`)
3. `pickNextStory()` wählt die nächste aktive Story
4. `createRunFolder()` legt `.codex-workflow/runs/{id}-{slug}` an
5. Feature-Branch von `main` nach Pattern `feature/{id}-{slug}`
6. Planning Loop:
   - planner -> `plan.md`
   - plan_reviewer -> `plan_review.md`
   - `validator.js`
   - bei `VERDICT: BLOCK` erneuter Planner-Durchlauf
7. Implementation Loop:
   - implementer readback -> `dev_plan_ack.md`
   - implementer implementation output
   - (wenn vorhanden) Patch-Anwendung im Working Tree
8. Diff Review Loop:
   - diff_reviewer auf `git diff` + Plan
   - bei `BLOCK` zurück in Implementation
9. Verification:
   - führt `verification_commands` exakt aus `config.yaml` aus
   - schreibt `verify_report.md` + command logs
   - bei FAIL zurück in Implementation
10. Publish:
   - `publish_summary.md` erzeugen
   - committen, pushen, PR erstellen/aktualisieren via `gh`
   - auf `required_checks` warten
   - bei CI-FAIL/Timeout: PR kommentieren und stoppen
   - kein Auto-Merge

## Modellrouting und callAgent

`callAgent(role, input, modelOverride?)` ist konfigurierbar und liest Modellwahl aus `config.yaml`.

Aktuelles Standardrouting:

- Planning/Non-Code:
  - `planner` -> `gpt-5.2` (`xhigh`)
  - `plan_reviewer` -> `gpt-5.2` (`xhigh`)
  - `publisher` -> `gpt-5.2` (`xhigh`)
- Coding:
  - `implementer` -> `gpt-5.3-codex` (`xhigh`)
  - `diff_reviewer` -> `gpt-5.3-codex` (`xhigh`)

Konfigurierbar in:

- `models.*`
- `reasoning_effort.*`

## Auth und Agent-Transport

Standard ist CLI-basierter Transport:

- `agent_transport: "codex_cli"`

Das bedeutet:

- Orchestrator nutzt `codex exec`
- Auth erfolgt über normale Codex-CLI-Session (`codex login`)
- Login wird durch `codex login status` geprüft

Wichtige Config-Keys:

- `codex_cli_command`
- `codex_cli_sandbox_mode`
- `codex_cli_approval_policy`
- `codex_cli_json_events`
- optional `codex_cli_extra_config`

## Decision Q&A und Timeout

Wenn ein Agent Decision Questions liefert, dann:

- Ausgabe in Console
- Persistenz als `pending_question_{N}.json` im Run-Ordner
- Antwort möglich per CLI oder `pending_question_{N}.answer.json`

Timeout-Regel:

- `qa_timeout_seconds` default: `3600` (1h)
- bei `full_auto: true` und Timeout:
  - `TIMEOUT_REPORT.md`
  - Story stoppt mit Status `blocked`

## Verification pro Projekt überschreiben

Die Verification ist nicht hardcodiert. Es zählt nur die Liste in `config.yaml`:

```yaml
verification_commands:
  - "pnpm install --frozen-lockfile"
  - "pnpm build"
  - "pnpm typecheck"
  - "pnpm test"
```

Du kannst diese Liste pro Projekt ersetzen (z. B. `npm`, `pytest`, `go test`, `cargo test`, etc.).

## Story-Lifecycle

`stories.yaml` wird bei jedem Orchestrator-Start neu aus `input/` aufgebaut.

Typische `status`-Werte während eines Runs sind:

- `todo`
- `in_progress`
- `blocked`
- `done`

Wichtig:

- diese Status sind Laufzeitstatus und werden beim nächsten Start erneut aus den Input-Dateien abgeleitet (Reset auf `todo`)
- wenn eine Story nicht mehr aktiv sein soll, Datei nach `input/archiv/` verschieben

## Commit/PR Verhalten

Publish-Phase:

1. staged alle Änderungen
2. unstaget Run-Artefakte unter `.codex-workflow/runs`
3. erzeugt einen Commit basierend auf `publish_summary.md`
4. pusht Feature-Branch
5. erstellt/updated PR per `gh`
6. wartet auf Required Checks (`required_checks: all_required`)

Wichtig:

- kein Auto-Merge
- bei CI-Problemen Kommentar in PR + Stop

## Häufige Probleme

`ERR_PNPM_NO_PKG_MANIFEST`:

- Ursache: kein `package.json` im Repo
- Lösung: `package.json` anlegen oder `verification_commands` anpassen

`codex_cli transport requires active CLI auth`:

- Ursache: keine aktive Codex-Session
- Lösung: `codex login` und erneut starten

`gh` PR/Checks Fehler:

- `gh auth status` prüfen
- Repo-Rechte und Branch-Protection prüfen

## Konfigurationsempfehlung für Modellupdates

Wenn du später Modelle wechselst, nur in `config.yaml` ändern:

- `models.*`
- optional `reasoning_effort.*`

Der Orchestrator-Code muss dafür normalerweise nicht geändert werden.

## Wichtige TODO-Marker

Im Code sind bewusst TODO-Marker vorhanden für produktive Erweiterungen:

- echte Endpoint-/Provider-Wiring (falls nicht Codex CLI)
- ggf. API-Key/Auth-Flows statt CLI-Session
- robustere Patch-Anwendung/Format-Validierung
- org-spezifische Git/CI-Policies

## Weitere Doku

Details zum Workflow-Scaffold selbst:

- `.codex-workflow/README.md`
