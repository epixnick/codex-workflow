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

## Installation und erster Run (einfach)

Voraussetzungen:

- Node.js 18+
- git
- gh (GitHub CLI)
- codex CLI
- projektabhängige Toolchain für `verification_commands` (Default: pnpm)
- Git-Remote `origin` und Branch `main` müssen existieren (mit mindestens einem Commit)

### 1) Muss ich den Ordner ins Repo kopieren?

Ja. Der Workflow funktioniert nur, wenn der Ordner `.codex-workflow/` im **Root deines Ziel-Repos** liegt.

Wenn du dieses Scaffold in ein anderes Repo übernehmen willst:

```bash
cp -R /pfad/zu/codex-workflow/.codex-workflow /pfad/zu/deinem-repo/
cd /pfad/zu/deinem-repo
mkdir -p .codex-workflow/runs
touch .codex-workflow/runs/.gitkeep
```

Empfohlen für `.gitignore` im Ziel-Repo:

```gitignore
.codex-workflow/runs/*
!.codex-workflow/runs/.gitkeep
```

### 2) Auth einrichten

```bash
codex login
codex login status
gh auth status
```

### 3) Projekt-Verification anpassen

In `.codex-workflow/config.yaml` muss `verification_commands` zu deinem Projekt passen.

Default (pnpm):

```yaml
verification_commands:
  - "pnpm install --frozen-lockfile"
  - "pnpm build"
  - "pnpm typecheck"
  - "pnpm test"
```

Wenn dein Projekt kein pnpm nutzt, diese Liste ersetzen.

### 4) Erste Story anlegen

Du brauchst immer **zwei Stellen** mit exakt gleichem `id` + `slug`:

1. Eintrag in `.codex-workflow/stories.yaml`
2. Story-Datei in `.codex-workflow/input/{id}-{slug}.md`

Namensregeln:

- `id`: am besten dreistellig, aufsteigend (`001`, `002`, `003`, ...)
- `slug`: lowercase-kebab-case (z. B. `auth-refactor`)
- Input-Dateiname: exakt `{id}-{slug}.md` (z. B. `001-auth-refactor.md`)

Beispiel `stories.yaml`:

```yaml
stories:
  - id: "001"
    slug: "auth-refactor"
    title: "Auth Refactor"
    status: "todo"
    depends_on: []
```

Beispiel Story-Datei:

- Pfad: `.codex-workflow/input/001-auth-refactor.md`
- Inhalt: Ziel, Scope, Acceptance Criteria (frei formulierbar)

### 5) Workflow starten

Im Repo-Root:

```bash
node .codex-workflow/scripts/orchestrator.js
```

Der Orchestrator nimmt automatisch die nächste Story mit `status: todo`, deren `depends_on` erfüllt sind.

### 6) Wo liegen Ergebnisse?

Pro Story-Run in:

- `.codex-workflow/runs/{id}-{slug}/`

Dort liegen u. a.:

- `story.md`
- `plan.md`
- `plan_review.md`
- `dev_plan_ack.md`
- `diff_review.md`
- `verify_report.md`
- `publish_summary.md`
- `pending_question_{N}.json` (falls Decision Q&A)
- `TIMEOUT_REPORT.md` (bei Q&A-Timeout in `full_auto`)

### 7) Mehrere Storys korrekt benennen

Empfehlung:

- `001-...`, `002-...`, `003-...` fortlaufend
- pro Story genau ein Input-File mit gleichem `id`/`slug` wie in `stories.yaml`
- `depends_on` mit Story-IDs füllen, wenn Reihenfolge erzwungen werden soll

Beispiel:

```yaml
stories:
  - id: "001"
    slug: "project-bootstrap"
    title: "Project Bootstrap"
    status: "done"
    depends_on: []
  - id: "002"
    slug: "auth-refactor"
    title: "Auth Refactor"
    status: "todo"
    depends_on: ["001"]
```

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
- `stories.yaml`: Story-Queue mit Status und Dependencies
- `input/{id}-{slug}.md`: Story-Input
- `runs/{id}-{slug}/`: Run-Artefakte und Logs
- `templates/*.tpl`: machine-readable Ausgabeformate je Phase
- `orchestrator.js`: state machine und Loop-Koordination
- `validator.js`: validiert Plan-/Review-Artefakte
- `git-helpers.sh`: git/gh-Helfer

## End-to-End Ablauf

`orchestrator.js` macht pro Story (vereinfacht):

1. `loadConfig()`
2. `pickNextStory()` wählt die kleinste `todo`-Story mit erfüllten `depends_on`
3. `createRunFolder()` legt `.codex-workflow/runs/{id}-{slug}` an
4. Feature-Branch von `main` nach Pattern `feature/{id}-{slug}`
5. Planning Loop:
   - planner -> `plan.md`
   - plan_reviewer -> `plan_review.md`
   - `validator.js`
   - bei `VERDICT: BLOCK` erneuter Planner-Durchlauf
6. Implementation Loop:
   - implementer readback -> `dev_plan_ack.md`
   - implementer implementation output
   - (wenn vorhanden) Patch-Anwendung im Working Tree
7. Diff Review Loop:
   - diff_reviewer auf `git diff` + Plan
   - bei `BLOCK` zurück in Implementation
8. Verification:
   - führt `verification_commands` exakt aus `config.yaml` aus
   - schreibt `verify_report.md` + command logs
   - bei FAIL zurück in Implementation
9. Publish:
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

Typische `status`-Werte in `stories.yaml`:

- `todo`
- `in_progress`
- `blocked`
- `done`

`depends_on` wird respektiert, bevor eine Story gestartet wird.

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
