# Story 001: Example Story

## Goal
Bootstrap a robust codex-workflow orchestration scaffold that can be adapted to real model endpoints and CI environments.

## Scope
- Create workflow scripts, templates, and defaults.
- Keep runtime behavior deterministic and auditable under `.codex-workflow/runs/`.
- Support decision Q&A with timeout handling.

## Acceptance Criteria
- Orchestrator can pick this story from `stories.yaml`.
- A run folder is created with generated artifacts.
- Planning, review, verification, and publish phases produce expected files.
