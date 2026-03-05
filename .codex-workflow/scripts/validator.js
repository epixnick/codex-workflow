#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    runDir: "",
    phase: "all",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--run-dir") {
      args.runDir = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (token === "--phase") {
      args.phase = argv[i + 1] || "all";
      i += 1;
      continue;
    }
  }

  return args;
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeValidationError(runDir, errors) {
  const payload = {
    timestamp: new Date().toISOString(),
    errors,
  };
  const outPath = path.join(runDir, "validation_error.json");
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function extractFrontMatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return null;
  }
  return match[1];
}

function parseYamlArray(lines, startIdx) {
  const values = [];
  let idx = startIdx;

  while (idx < lines.length) {
    const line = lines[idx];
    if (!line.trim()) {
      idx += 1;
      continue;
    }

    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();

    if (indent < 2 || !trimmed.startsWith("- ")) {
      break;
    }

    values.push(trimmed.slice(2).trim().replace(/^"|"$/g, ""));
    idx += 1;
  }

  return { values, nextIdx: idx };
}

function parseFrontMatterYaml(frontMatter) {
  const lines = frontMatter.split(/\r?\n/);
  const obj = {};

  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx];
    if (!line.trim()) {
      idx += 1;
      continue;
    }

    const indent = line.match(/^ */)[0].length;
    if (indent !== 0) {
      throw new Error(`Invalid front matter indentation near: ${line}`);
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) {
      throw new Error(`Expected key:value in front matter near: ${line}`);
    }

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (rawValue === "") {
      const parsedArray = parseYamlArray(lines, idx + 1);
      obj[key] = parsedArray.values;
      idx = parsedArray.nextIdx;
      continue;
    }

    if (rawValue === "[]") {
      obj[key] = [];
      idx += 1;
      continue;
    }

    if (/^-?\d+$/.test(rawValue)) {
      obj[key] = Number(rawValue);
      idx += 1;
      continue;
    }

    obj[key] = rawValue.replace(/^"|"$/g, "");
    idx += 1;
  }

  return obj;
}

function validatePlan(planPath, errors) {
  if (!fileExists(planPath)) {
    errors.push({ file: path.basename(planPath), message: "Missing file" });
    return;
  }

  const markdown = readFile(planPath);
  const frontMatter = extractFrontMatter(markdown);
  if (!frontMatter) {
    errors.push({
      file: path.basename(planPath),
      message: "Missing YAML front matter block delimited by ---",
    });
    return;
  }

  let parsed;
  try {
    parsed = parseFrontMatterYaml(frontMatter);
  } catch (error) {
    errors.push({
      file: path.basename(planPath),
      message: `Front matter parse error: ${error.message}`,
    });
    return;
  }

  const requiredKeys = ["story_id", "version", "assumptions", "files_to_touch", "tests"];
  for (const key of requiredKeys) {
    if (!(key in parsed)) {
      errors.push({ file: path.basename(planPath), message: `Missing required key: ${key}` });
    }
  }

  if ("files_to_touch" in parsed && !Array.isArray(parsed.files_to_touch)) {
    errors.push({ file: path.basename(planPath), message: "files_to_touch must be an array" });
  }

  if ("tests" in parsed && !Array.isArray(parsed.tests)) {
    errors.push({ file: path.basename(planPath), message: "tests must be an array" });
  }
}

function validateVerdictFile(filePath, errors) {
  if (!fileExists(filePath)) {
    errors.push({ file: path.basename(filePath), message: "Missing file" });
    return;
  }

  const firstLine = readFile(filePath).split(/\r?\n/)[0].trim();
  if (firstLine !== "VERDICT: PASS" && firstLine !== "VERDICT: BLOCK") {
    errors.push({
      file: path.basename(filePath),
      message: `First line must be VERDICT: PASS or VERDICT: BLOCK, got: ${firstLine || "<empty>"}`,
    });
  }
}

function validate(runDir, phase) {
  const errors = [];

  const planPath = path.join(runDir, "plan.md");
  const planReviewPath = path.join(runDir, "plan_review.md");
  const diffReviewPath = path.join(runDir, "diff_review.md");

  if (phase === "planning") {
    validatePlan(planPath, errors);
    validateVerdictFile(planReviewPath, errors);
  } else if (phase === "diff") {
    validatePlan(planPath, errors);
    validateVerdictFile(planReviewPath, errors);
    validateVerdictFile(diffReviewPath, errors);
  } else {
    validatePlan(planPath, errors);
    validateVerdictFile(planReviewPath, errors);
    validateVerdictFile(diffReviewPath, errors);
  }

  return errors;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.runDir) {
    console.error("Usage: node validator.js --run-dir <path> [--phase planning|diff|all]");
    process.exit(2);
  }

  if (!fileExists(args.runDir)) {
    console.error(`Run directory does not exist: ${args.runDir}`);
    process.exit(2);
  }

  const errors = validate(args.runDir, args.phase);
  if (errors.length > 0) {
    writeValidationError(args.runDir, errors);
    console.error(`Validation failed with ${errors.length} error(s).`);
    process.exit(1);
  }

  process.exit(0);
}

main();
