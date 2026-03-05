# codex-workflow bootstrap

This folder provides a full bootstrap scaffold for running story-based planning, implementation, review, verification, and publishing loops.

## What is included

- `stories.yaml`: source of truth for story queue and dependency gating.
- `input/`: markdown story inputs (`{id}-{slug}.md`).
- `runs/`: runtime artifacts per story run (`.codex-workflow/runs/{id}-{slug}/...`).
- `templates/*.tpl`: strict output formats for each workflow stage.
- `scripts/orchestrator.js`: Node 18+ orchestrator.
- `scripts/validator.js`: validates planning/review artifacts.
- `scripts/git-helpers.sh`: git + gh helper commands for branching/publishing.
- `config.yaml`: all key runtime settings.

## Requirements

- Node.js 18+
- `git`
- `gh` (GitHub CLI) for PR creation/update and check waiting when `use_gh_cli: true`
- `codex` CLI for agent calls when `agent_transport: codex_cli`
- Project verification toolchain matching `verification_commands` (default uses `pnpm`)

No external Node dependencies are required by default.

## Run

From repo root:

```bash
node .codex-workflow/scripts/orchestrator.js
```

For Codex CLI transport, authenticate once:

```bash
codex login
codex login status
```

## Core behavior (as implemented)

1. Loads config from `.codex-workflow/config.yaml` via `loadConfig()`.
2. Picks next eligible story via `pickNextStory()`:
   - smallest `id` with `status: todo`
   - `depends_on` must all be `done`
3. Creates run folder via `createRunFolder(story)`.
4. Ensures feature branch from `main` based on pattern `feature/{id}-{slug}`.
5. Runs planning loop (`runPlanningLoop()`):
   - planner -> `plan.md`
   - plan reviewer -> `plan_review.md`
   - validate with `validator.js`
   - loop while `VERDICT: BLOCK`
6. Runs implementation loop (`runImplementationLoop()`):
   - implementer readback -> `dev_plan_ack.md`
   - implementer implementation response
   - patch apply placeholder (`git apply` if patch provided)
7. Runs diff review loop (`runDiffReview()`):
   - reviewer sees uncommitted diff + plan
   - writes `diff_review.md`
   - loops on `VERDICT: BLOCK` by re-entering implementation
8. Runs verification (`runVerification()`):
   - executes commands **exactly** from `config.yaml` in order
   - writes logs and `verify_report.md`
   - on failure returns to implementation loop
9. Runs publishing (`runPublisher()`):
   - aggregates story/plan/diff review/verify report/diff stat
   - writes `publish_summary.md`
   - creates commit from summary title/body
   - pushes feature branch
   - creates/updates PR via `gh`
   - waits for required checks (`required_checks: all_required`)
   - on CI fail/timeout: annotate PR and stop (no auto-merge)

## Decision Q&A behavior

`handleQnA()` writes pending questions to:

- `.codex-workflow/runs/{id}-{slug}/pending_question_{N}.json`

Answer options:

- Interactive CLI input (when TTY is available)
- Drop-in file answer at `pending_question_{N}.answer.json`

Timeout behavior:

- `qa_timeout_seconds` defaults to `3600` (1h)
- In `full_auto: true`, unanswered decision question triggers:
  - `.codex-workflow/runs/{id}-{slug}/TIMEOUT_REPORT.md`
  - story processing stops for that story

## Commit behavior (exact)

`runPublisher()` uses this commit policy:

1. `git add -A`
2. unstage `.codex-workflow/runs` artifacts
3. create one commit using `COMMIT_TITLE` and `COMMIT_BODY` from `publish_summary.md`
4. push `feature/{id}-{slug}`

If nothing remains staged after excluding run artifacts, publish skips commit/push/PR.

## TODO markers you must wire for real usage

- `scripts/orchestrator.js`:
  - `callAgent(...)` is wired to `codex exec` by default; replace transport if you need direct API calls
  - replace placeholder model aliases with real endpoint mapping
  - replace/extend patch application adapter to Codex-CLI/API output contract
- `scripts/git-helpers.sh`:
  - ensure `gh` auth and repository policy alignment
  - adjust fetch/pull and branch strategy if your repo requires stricter controls
- `config.yaml`:
  - all `models.*` values are placeholders and tagged with TODO comments

## Config defaults (override per project)

- Branch pattern: `feature/{id}-{slug}`
- Base/PR target: `main`
- PR transport: GitHub CLI (`use_gh_cli: true`)
- Required checks policy: `all_required`
- Agent transport: `codex_cli` (CLI-auth based)
- Role model mapping:
  - planning/non-code roles (`planner`, `plan_reviewer`, `publisher`) -> `gpt-5.2` (`xhigh`)
  - coding roles (`implementer`, `diff_reviewer`) -> `gpt-5.3-codex` (`xhigh`)
- Verification commands:
  1. `pnpm install --frozen-lockfile`
  2. `pnpm build`
  3. `pnpm typecheck`
  4. `pnpm test`

The orchestrator does **not** hardcode verification commands; it reads and executes the list from `config.yaml`.
