#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

log() {
  printf '[%s] [%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$SCRIPT_NAME" "$*"
}

usage() {
  cat <<USAGE
Usage:
  $SCRIPT_NAME ensure-branch <id> <slug> <branch_pattern> <base_branch>
  $SCRIPT_NAME push-branch <branch>
  $SCRIPT_NAME create-or-update-pr <branch> <base_branch> <title_file> <body_file>
  $SCRIPT_NAME wait-required-checks <pr_ref_or_url> <timeout_seconds>
  $SCRIPT_NAME annotate-pr <pr_ref_or_url> <message>

Notes:
- TODO: ensure gh auth is configured for your environment.
- TODO: adapt branch hygiene policy to your repository constraints.
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

render_branch_name() {
  local id="$1"
  local slug="$2"
  local pattern="$3"
  local branch
  branch="${pattern//\{id\}/$id}"
  branch="${branch//\{slug\}/$slug}"
  printf '%s' "$branch"
}

ensure_clean_if_needed() {
  # This workflow assumes branch creation from base branch. If working tree is dirty,
  # we keep user changes and only warn instead of auto-resetting.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    log "Working tree has local changes; branch operations proceed without reset"
  fi
}

cmd_ensure_branch() {
  local id="$1"
  local slug="$2"
  local pattern="$3"
  local base_branch="$4"

  require_cmd git
  ensure_clean_if_needed

  local branch
  branch="$(render_branch_name "$id" "$slug" "$pattern")"

  # Always start from configured base branch if possible.
  git checkout "$base_branch"

  # TODO: for protected repos, ensure the following fetch/pull behavior matches policy.
  git fetch origin "$base_branch" || true
  git pull --ff-only origin "$base_branch" || true

  git checkout -B "$branch"
  log "Checked out branch: $branch"
}

cmd_push_branch() {
  local branch="$1"
  require_cmd git
  git push -u origin "$branch"
  log "Pushed branch: $branch"
}

cmd_create_or_update_pr() {
  local branch="$1"
  local base_branch="$2"
  local title_file="$3"
  local body_file="$4"

  require_cmd gh

  # TODO: ensure `gh auth status` succeeds in target environment.

  local title
  title="$(cat "$title_file")"

  local existing
  existing="$(gh pr list --head "$branch" --json number --jq '.[0].number' 2>/dev/null || true)"

  if [[ -n "$existing" && "$existing" != "null" ]]; then
    gh pr edit "$existing" --title "$title" --body-file "$body_file"
    gh pr view "$existing" --json url --jq '.url'
    return
  fi

  gh pr create --base "$base_branch" --head "$branch" --title "$title" --body-file "$body_file"
}

cmd_wait_required_checks() {
  local pr_ref="$1"
  local timeout_seconds="$2"
  require_cmd gh

  local start now elapsed
  start="$(date +%s)"

  while true; do
    # `gh pr checks --required` returns 0 when all required checks pass.
    # It returns non-zero when checks are pending or failing.
    if gh pr checks "$pr_ref" --required >/tmp/codex-workflow-pr-checks.log 2>&1; then
      cat /tmp/codex-workflow-pr-checks.log
      log "Required checks passed"
      return 0
    fi

    now="$(date +%s)"
    elapsed="$((now - start))"

    if [[ "$elapsed" -ge "$timeout_seconds" ]]; then
      cat /tmp/codex-workflow-pr-checks.log
      log "Timed out waiting for required checks"
      return 124
    fi

    # If checks are failing, we still keep polling until timeout to allow retried jobs.
    sleep 15
  done
}

cmd_annotate_pr() {
  local pr_ref="$1"
  local message="$2"
  require_cmd gh
  gh pr comment "$pr_ref" --body "$message"
}

main() {
  if [[ "$#" -lt 1 ]]; then
    usage
    exit 2
  fi

  local cmd="$1"
  shift

  case "$cmd" in
    ensure-branch)
      [[ "$#" -eq 4 ]] || { usage; exit 2; }
      cmd_ensure_branch "$@"
      ;;
    push-branch)
      [[ "$#" -eq 1 ]] || { usage; exit 2; }
      cmd_push_branch "$@"
      ;;
    create-or-update-pr)
      [[ "$#" -eq 4 ]] || { usage; exit 2; }
      cmd_create_or_update_pr "$@"
      ;;
    wait-required-checks)
      [[ "$#" -eq 2 ]] || { usage; exit 2; }
      cmd_wait_required_checks "$@"
      ;;
    annotate-pr)
      [[ "$#" -eq 2 ]] || { usage; exit 2; }
      cmd_annotate_pr "$@"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
