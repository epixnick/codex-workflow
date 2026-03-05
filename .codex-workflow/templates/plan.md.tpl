# PLAN TEMPLATE (strict)

Use this exact shape. The YAML front matter is mandatory.

---
story_id: "001"
version: 1
assumptions:
  - "Assumption 1"
files_to_touch:
  - "path/to/file.ts"
tests:
  - "pnpm test -- path/to/spec"
---

## SUMMARY
- One concise paragraph describing intent and boundaries.

## IMPLEMENTATION_STEPS
1. First concrete implementation step.
2. Second concrete implementation step.

## DECISION_QUESTIONS_JSON
```json
[]
```

Decision question format (array of objects):
```json
[
  {
    "id": "dq-1",
    "question": "Which API variant should be used?",
    "options": [
      { "id": "a", "label": "Variant A" },
      { "id": "b", "label": "Variant B" }
    ],
    "metadata": {
      "reason": "Needed to avoid implementation ambiguity"
    }
  }
]
```
