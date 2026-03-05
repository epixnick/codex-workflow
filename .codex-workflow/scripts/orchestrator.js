#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

const REPO_ROOT = process.cwd();
const WORKFLOW_DIR = path.join(REPO_ROOT, ".codex-workflow");
const CONFIG_PATH = path.join(WORKFLOW_DIR, "config.yaml");
const STORIES_PATH = path.join(WORKFLOW_DIR, "stories.yaml");
const INPUT_DIR = path.join(WORKFLOW_DIR, "input");
const RUNS_DIR = path.join(WORKFLOW_DIR, "runs");
const TEMPLATES_DIR = path.join(WORKFLOW_DIR, "templates");
const SCRIPTS_DIR = path.join(WORKFLOW_DIR, "scripts");
const GIT_HELPERS_PATH = path.join(SCRIPTS_DIR, "git-helpers.sh");
const VALIDATOR_PATH = path.join(SCRIPTS_DIR, "validator.js");

const DEFAULT_CONFIG = {
  branch_pattern: "feature/{id}-{slug}",
  base_branch: "main",
  pr_target: "main",
  use_gh_cli: true,
  required_checks: "all_required",
  verification_commands: [
    "pnpm install --frozen-lockfile",
    "pnpm build",
    "pnpm typecheck",
    "pnpm test",
  ],
  models: {
    planner: "gpt-5.2", // TODO: replace model alias / wire to real endpoint
    plan_reviewer: "gpt-5.2", // TODO: replace model alias / wire to real endpoint
    implementer: "gpt-5.3-codex", // TODO: replace model alias / wire to real endpoint
    diff_reviewer: "gpt-5.2", // TODO: replace model alias / wire to real endpoint
    publisher: "gpt-5.3-codex", // TODO: replace model alias / wire to real endpoint
  },
  qa_timeout_seconds: 3600,
  full_auto: false,
};

const MAX_LOOP_ATTEMPTS = 10;
const DEFAULT_CI_TIMEOUT_SECONDS = 3600;
let ACTIVE_CONFIG = null;

class WorkflowError extends Error {
  constructor(message, code = "WORKFLOW_ERROR") {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

class QATimeoutError extends WorkflowError {
  constructor(message) {
    super(message, "QA_TIMEOUT");
    this.name = "QATimeoutError";
  }
}

function log(step, message) {
  const now = new Date().toISOString();
  console.log(`[${now}] [${step}] ${message}`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    const prev = i > 0 ? line[i - 1] : "";
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle && prev !== "\\") {
      inDouble = !inDouble;
      continue;
    }
    if (c === "#" && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }

  return line;
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineArray(raw) {
  const trimmed = raw.trim();
  if (trimmed === "[]") {
    return [];
  }
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new WorkflowError(`Invalid inline array: ${raw}`, "PARSE_ERROR");
  }

  const inside = trimmed.slice(1, -1).trim();
  if (!inside) {
    return [];
  }

  return inside
    .split(",")
    .map((part) => parseScalar(part.trim()))
    .map((item) => `${item}`);
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "") {
    return "";
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  if (value === "[]" || (value.startsWith("[") && value.endsWith("]"))) {
    return parseInlineArray(value);
  }
  return unquote(value);
}

function splitKeyValue(line) {
  const idx = line.indexOf(":");
  if (idx < 0) {
    throw new WorkflowError(`Expected key:value line, got: ${line}`, "PARSE_ERROR");
  }
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  return [key, value];
}

function parseConfigYaml(content) {
  const cfg = {};
  const lines = content.split(/\r?\n/);
  let section = null;

  for (const originalLine of lines) {
    const noComment = stripInlineComment(originalLine).replace(/\t/g, "    ");
    if (!noComment.trim()) {
      continue;
    }

    const indent = noComment.match(/^ */)[0].length;
    const trimmed = noComment.trim();

    if (indent === 0) {
      section = null;
      const [key, rawValue] = splitKeyValue(trimmed);
      if (rawValue === "") {
        if (key === "verification_commands") {
          cfg.verification_commands = [];
          section = "verification_commands";
        } else if (key === "models") {
          cfg.models = {};
          section = "models";
        } else {
          cfg[key] = {};
          section = key;
        }
      } else {
        cfg[key] = parseScalar(rawValue);
      }
      continue;
    }

    if (indent === 2 && section === "verification_commands") {
      if (!trimmed.startsWith("- ")) {
        throw new WorkflowError(`Invalid verification_commands item: ${trimmed}`, "PARSE_ERROR");
      }
      cfg.verification_commands.push(parseScalar(trimmed.slice(2)));
      continue;
    }

    if (indent === 2 && section === "models") {
      const [key, rawValue] = splitKeyValue(trimmed);
      cfg.models[key] = parseScalar(rawValue);
      continue;
    }

    if (indent === 2 && section && cfg[section] && typeof cfg[section] === "object" && !Array.isArray(cfg[section])) {
      const [key, rawValue] = splitKeyValue(trimmed);
      cfg[section][key] = parseScalar(rawValue);
      continue;
    }

    throw new WorkflowError(`Unsupported config.yaml structure near line: ${originalLine}`, "PARSE_ERROR");
  }

  return cfg;
}

function parseStoriesYaml(content) {
  const stories = [];
  const lines = content.split(/\r?\n/);

  let hasStoriesRoot = false;
  let current = null;
  let inDependsList = false;

  for (const originalLine of lines) {
    const noComment = stripInlineComment(originalLine).replace(/\t/g, "    ");
    if (!noComment.trim()) {
      continue;
    }

    const indent = noComment.match(/^ */)[0].length;
    const trimmed = noComment.trim();

    if (indent === 0 && trimmed === "stories:") {
      hasStoriesRoot = true;
      continue;
    }

    if (!hasStoriesRoot) {
      continue;
    }

    if (indent === 2 && trimmed.startsWith("- ")) {
      inDependsList = false;
      current = { depends_on: [] };
      stories.push(current);

      const inline = trimmed.slice(2).trim();
      if (inline) {
        const [key, rawValue] = splitKeyValue(inline);
        current[key] = parseScalar(rawValue);
      }
      continue;
    }

    if (!current) {
      throw new WorkflowError(`Story item missing list marker near line: ${originalLine}`, "PARSE_ERROR");
    }

    if (indent === 4) {
      inDependsList = false;
      const [key, rawValue] = splitKeyValue(trimmed);
      if (key === "depends_on") {
        if (!rawValue) {
          current.depends_on = [];
          inDependsList = true;
        } else {
          const parsed = parseScalar(rawValue);
          current.depends_on = Array.isArray(parsed) ? parsed.map((x) => `${x}`) : [`${parsed}`];
        }
      } else {
        current[key] = parseScalar(rawValue);
      }
      continue;
    }

    if (indent === 6 && inDependsList && trimmed.startsWith("- ")) {
      current.depends_on.push(`${parseScalar(trimmed.slice(2))}`);
      continue;
    }

    throw new WorkflowError(`Unsupported stories.yaml structure near line: ${originalLine}`, "PARSE_ERROR");
  }

  for (const story of stories) {
    if (!story.id || !story.slug || !story.status) {
      throw new WorkflowError(`Story missing required fields (id/slug/status): ${JSON.stringify(story)}`, "PARSE_ERROR");
    }
    if (!Array.isArray(story.depends_on)) {
      story.depends_on = [];
    }
    story.id = `${story.id}`;
  }

  return stories;
}

function serializeStoriesYaml(stories) {
  const lines = ["stories:"];

  for (const story of stories) {
    lines.push(`  - id: "${story.id}"`);
    lines.push(`    slug: "${story.slug}"`);
    if (story.title) {
      lines.push(`    title: "${story.title}"`);
    }
    lines.push(`    status: "${story.status}"`);
    if (story.note) {
      lines.push(`    note: "${story.note.replace(/"/g, "'")}"`);
    }

    if (!story.depends_on || story.depends_on.length === 0) {
      lines.push("    depends_on: []");
    } else {
      lines.push("    depends_on:");
      for (const dep of story.depends_on) {
        lines.push(`      - "${dep}"`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

function deepMerge(base, override) {
  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, overrideValue] of Object.entries(override || {})) {
    const baseValue = result[key];
    if (
      baseValue &&
      overrideValue &&
      typeof baseValue === "object" &&
      typeof overrideValue === "object" &&
      !Array.isArray(baseValue) &&
      !Array.isArray(overrideValue)
    ) {
      result[key] = deepMerge(baseValue, overrideValue);
      continue;
    }
    result[key] = overrideValue;
  }
  return result;
}

function loadConfig() {
  if (!fileExists(CONFIG_PATH)) {
    throw new WorkflowError(`Missing config file at ${CONFIG_PATH}`);
  }

  const raw = readFile(CONFIG_PATH);
  const parsed = parseConfigYaml(raw);
  const config = deepMerge(DEFAULT_CONFIG, parsed);

  if (!Array.isArray(config.verification_commands) || config.verification_commands.length === 0) {
    throw new WorkflowError("config.yaml verification_commands must be a non-empty array", "CONFIG_ERROR");
  }
  if (!config.models || typeof config.models !== "object") {
    throw new WorkflowError("config.yaml models must be an object", "CONFIG_ERROR");
  }
  if (typeof config.qa_timeout_seconds !== "number" || config.qa_timeout_seconds <= 0) {
    throw new WorkflowError("config.yaml qa_timeout_seconds must be a positive number", "CONFIG_ERROR");
  }

  return config;
}

function loadStories() {
  if (!fileExists(STORIES_PATH)) {
    throw new WorkflowError(`Missing stories file at ${STORIES_PATH}`);
  }
  return parseStoriesYaml(readFile(STORIES_PATH));
}

function saveStories(stories) {
  writeFile(STORIES_PATH, serializeStoriesYaml(stories));
}

function pickNextStory() {
  const stories = loadStories();
  const byId = new Map(stories.map((story) => [story.id, story]));

  const todoStories = stories
    .filter((story) => story.status === "todo")
    .sort((a, b) => Number(a.id) - Number(b.id));

  for (const candidate of todoStories) {
    const deps = candidate.depends_on || [];
    const depsSatisfied = deps.every((depId) => {
      const dep = byId.get(`${depId}`);
      return dep && dep.status === "done";
    });
    if (depsSatisfied) {
      return candidate;
    }
  }

  return null;
}

function updateStoryStatus(storyId, status, note = "") {
  const stories = loadStories();
  const story = stories.find((item) => `${item.id}` === `${storyId}`);
  if (!story) {
    return;
  }
  story.status = status;
  if (note) {
    story.note = note;
  }
  saveStories(stories);
}

function createRunFolder(story) {
  const runSlug = `${story.id}-${story.slug}`;
  const runDir = path.join(RUNS_DIR, runSlug);
  ensureDir(runDir);

  const inputStoryPath = path.join(INPUT_DIR, `${story.id}-${story.slug}.md`);
  if (!fileExists(inputStoryPath)) {
    throw new WorkflowError(`Story input missing: ${inputStoryPath}`, "MISSING_STORY_INPUT");
  }

  const storyMdPath = path.join(runDir, "story.md");
  fs.copyFileSync(inputStoryPath, storyMdPath);

  const metadata = {
    story_id: story.id,
    slug: story.slug,
    started_at: new Date().toISOString(),
  };
  writeFile(path.join(runDir, "run_metadata.json"), JSON.stringify(metadata, null, 2));

  return {
    runSlug,
    runDir,
    storyMdPath,
    planPath: path.join(runDir, "plan.md"),
    planReviewPath: path.join(runDir, "plan_review.md"),
    devPlanAckPath: path.join(runDir, "dev_plan_ack.md"),
    diffReviewPath: path.join(runDir, "diff_review.md"),
    verifyReportPath: path.join(runDir, "verify_report.md"),
    publishSummaryPath: path.join(runDir, "publish_summary.md"),
  };
}

function runCommand(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: "utf8",
    shell: Boolean(options.shell),
    stdio: options.stdio || "pipe",
  });

  if (result.error) {
    throw new WorkflowError(`${cmd} failed to spawn: ${result.error.message}`);
  }

  const code = typeof result.status === "number" ? result.status : 1;
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";

  if (!options.allowFailure && code !== 0) {
    throw new WorkflowError(`${cmd} ${args.join(" ")} failed (exit ${code})\n${stderr || stdout}`);
  }

  return { code, stdout, stderr };
}

function renderBranchName(pattern, story) {
  return pattern.replace("{id}", story.id).replace("{slug}", story.slug);
}

function ensureFeatureBranch(story, config) {
  const branchName = renderBranchName(config.branch_pattern, story);
  log("git", `Ensuring feature branch ${branchName} from ${config.base_branch}`);

  runCommand("bash", [
    GIT_HELPERS_PATH,
    "ensure-branch",
    story.id,
    story.slug,
    config.branch_pattern,
    config.base_branch,
  ]);

  return branchName;
}

function extractFirstLine(text) {
  return text.split(/\r?\n/)[0].trim();
}

function readVerdict(filePath) {
  if (!fileExists(filePath)) {
    throw new WorkflowError(`Missing verdict file: ${filePath}`, "MISSING_VERDICT_FILE");
  }
  const firstLine = extractFirstLine(readFile(filePath));
  if (firstLine === "VERDICT: PASS") {
    return "PASS";
  }
  if (firstLine === "VERDICT: BLOCK") {
    return "BLOCK";
  }
  throw new WorkflowError(`Invalid verdict line in ${filePath}: ${firstLine}`, "INVALID_VERDICT");
}

function runValidator(runDir, phase) {
  const result = runCommand(
    "node",
    [VALIDATOR_PATH, "--run-dir", runDir, "--phase", phase],
    { allowFailure: true }
  );

  if (result.code !== 0) {
    throw new WorkflowError(`Validation failed for phase=${phase}. See validation_error.json in ${runDir}`, "VALIDATION_ERROR");
  }
}

function extractJsonBlocks(markdown) {
  const blocks = [];
  const regex = /```json\s*([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

function extractDecisionQuestions(text) {
  const blocks = extractJsonBlocks(text || "");

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      if (Array.isArray(parsed) && parsed.every((item) => item && typeof item === "object" && item.question)) {
        return parsed;
      }
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.decision_questions)) {
        return parsed.decision_questions;
      }
    } catch (_error) {
      // ignore invalid json blocks
    }
  }

  return [];
}

function extractPatch(text) {
  if (!text) {
    return "";
  }

  const diffBlock = text.match(/```diff\s*([\s\S]*?)```/);
  if (diffBlock && diffBlock[1]) {
    return diffBlock[1].trim();
  }

  const patchBlock = text.match(/```patch\s*([\s\S]*?)```/);
  if (patchBlock && patchBlock[1]) {
    return patchBlock[1].trim();
  }

  return "";
}

function stubAgentResponse(role, input) {
  const storyId = input && input.story_id ? input.story_id : "001";

  if (role === "planner") {
    return {
      content: `---\nstory_id: "${storyId}"\nversion: 1\nassumptions:\n  - "TODO: confirm project-specific constraints and deployment environment."\nfiles_to_touch:\n  - "TODO: replace with concrete target files during real run."\ntests:\n  - "pnpm test"\n---\n\n## SUMMARY\n- Initial scaffold plan generated by stub transport.\n\n## UNCLEAR_AREAS\n- none\n\n## IMPLEMENTATION_STEPS\n1. Confirm unclear areas with decision questions if needed.\n2. Implement required changes and produce patch output.\n3. Validate and iterate until review passes.\n\n## DECISION_QUESTIONS_JSON\n\`\`\`json\n[]\n\`\`\`\n`,
    };
  }

  if (role === "plan_reviewer") {
    return {
      content: `VERDICT: PASS\nREVIEW_VERSION: 1\n\n## FINDINGS\n- Stub review accepted. Replace with real review model integration.\n\n## CHANGES_REQUIRED\n- none\n\n## DECISION_QUESTIONS_JSON\n\`\`\`json\n[]\n\`\`\`\n`,
    };
  }

  if (role === "implementer") {
    if (input && input.mode === "planning_readback") {
      return {
        content: `ACK_STATUS: CLEAR\nPLAN_VERSION: 1\n\n## UNDERSTANDING\n- Plan acknowledged by stub implementer.\n\n## UNCLEAR_AREAS\n- none\n\n## DECISION_QUESTIONS_JSON\n\`\`\`json\n[]\n\`\`\`\n`,
      };
    }

    return {
      content: `# IMPLEMENTER_OUTPUT\n\nNo patch generated in stub mode.\n\nTODO: replace model alias / wire to real endpoint and patch application path to Codex-CLI/API.\n\n## DECISION_QUESTIONS_JSON\n\`\`\`json\n[]\n\`\`\`\n`,
      patch: "",
    };
  }

  if (role === "diff_reviewer") {
    return {
      content: `VERDICT: PASS\nREVIEW_VERSION: 1\n\n## RISK_SUMMARY\n- Stub diff review accepted.\n\n## REQUIRED_FIXES\n- none\n\n## DECISION_QUESTIONS_JSON\n\`\`\`json\n[]\n\`\`\`\n`,
    };
  }

  if (role === "publisher") {
    return {
      content: `COMMIT_TITLE: chore(${storyId}): apply workflow implementation\n\nCOMMIT_BODY:\n- Generated by orchestrator stub publisher.\n- TODO: replace model alias / wire to real endpoint.\n\nPR_TITLE: [Story ${storyId}] Workflow update\n\nPR_BODY:\n## What changed\n- Generated publish summary by stub transport\n\n## Validation\n- Refer to verify_report.md\n\n## Notes\n- TODO: replace model alias / wire to real endpoint\n\n## DECISION_QUESTIONS_JSON\n\`\`\`json\n[]\n\`\`\`\n`,
    };
  }

  return { content: "" };
}

async function callAgent(role, input, modelOverride) {
  if (!ACTIVE_CONFIG) {
    throw new WorkflowError("Active config is not set before callAgent invocation", "CONFIG_ERROR");
  }

  const model = modelOverride || ACTIVE_CONFIG.models[role];
  if (!model) {
    throw new WorkflowError(`No model configured for role: ${role}`, "CONFIG_ERROR");
  }

  // TODO: replace model alias / wire to real endpoint.
  // TODO: add real authentication handling (API keys, org/project headers, endpoint routing).
  // TODO: integrate with Codex-CLI or OpenAI Platform API for production use.
  const transport = process.env.CODEX_WORKFLOW_AGENT_TRANSPORT || "stub";

  let rawResponse;
  if (transport === "stub") {
    rawResponse = stubAgentResponse(role, input || {});
  } else {
    throw new WorkflowError(
      `Unsupported agent transport: ${transport}. TODO: wire transport to real endpoint`,
      "AGENT_TRANSPORT_ERROR"
    );
  }

  const content = typeof rawResponse === "string" ? rawResponse : rawResponse.content || "";
  const decision_questions = rawResponse.decision_questions || extractDecisionQuestions(content);
  const patch = rawResponse.patch || extractPatch(content);

  return {
    role,
    model,
    content,
    decision_questions,
    patch,
    raw: rawResponse,
  };
}

function nextQuestionIndex(runDir) {
  const files = fs.readdirSync(runDir).filter((name) => /^pending_question_\d+\.json$/.test(name));
  if (files.length === 0) {
    return 1;
  }
  const max = files
    .map((name) => Number(name.match(/pending_question_(\d+)\.json/)[1]))
    .reduce((acc, value) => Math.max(acc, value), 0);
  return max + 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryReadJson(filePath) {
  if (!fileExists(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFile(filePath));
  } catch (error) {
    throw new WorkflowError(`Failed parsing JSON file ${filePath}: ${error.message}`, "JSON_PARSE_ERROR");
  }
}

async function waitForAnswerFile(answerPath, timeoutSeconds) {
  const timeoutAt = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < timeoutAt) {
    const parsed = tryReadJson(answerPath);
    if (parsed) {
      return parsed;
    }
    await sleep(2000);
  }
  return null;
}

function promptInput(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function buildTimeoutReport(runDir, questionFile, timeoutSeconds, context) {
  const now = new Date().toISOString();
  const report = `# TIMEOUT REPORT\n\n- timestamp: ${now}\n- timeout_seconds: ${timeoutSeconds}\n- question_file: ${path.basename(questionFile)}\n- context: ${context}\n\nProcessing for this story was stopped because decision Q&A timed out.`;
  writeFile(path.join(runDir, "TIMEOUT_REPORT.md"), report);
}

async function handleQnA(params) {
  const {
    runDir,
    decisionQuestions,
    config,
    role,
    phase,
  } = params;

  if (!decisionQuestions || decisionQuestions.length === 0) {
    return [];
  }

  const answers = [];

  for (const question of decisionQuestions) {
    const qIndex = nextQuestionIndex(runDir);
    const questionPath = path.join(runDir, `pending_question_${qIndex}.json`);
    const answerPath = path.join(runDir, `pending_question_${qIndex}.answer.json`);

    const payload = {
      question,
      metadata: {
        role,
        phase,
        timestamp: new Date().toISOString(),
      },
    };

    writeFile(questionPath, `${JSON.stringify(payload, null, 2)}\n`);

    log("qna", `Decision question #${qIndex} from ${role}/${phase}`);
    console.log(JSON.stringify(payload, null, 2));

    if (config.full_auto) {
      const answer = await waitForAnswerFile(answerPath, config.qa_timeout_seconds);
      if (!answer) {
        buildTimeoutReport(runDir, questionPath, config.qa_timeout_seconds, `${role}/${phase}`);
        throw new QATimeoutError(
          `Q&A timeout after ${config.qa_timeout_seconds}s for ${path.basename(questionPath)}`
        );
      }
      answers.push(answer);
      continue;
    }

    let answer = null;

    if (process.stdin.isTTY) {
      const typed = await promptInput(
        `Answer question #${qIndex} now (or press Enter to answer via ${path.basename(answerPath)}): `
      );
      if (typed && typed.trim()) {
        answer = {
          answer: typed.trim(),
          source: "interactive_cli",
          timestamp: new Date().toISOString(),
        };
        writeFile(answerPath, `${JSON.stringify(answer, null, 2)}\n`);
      }
    }

    if (!answer) {
      log("qna", `Waiting up to ${config.qa_timeout_seconds}s for ${path.basename(answerPath)}`);
      answer = await waitForAnswerFile(answerPath, config.qa_timeout_seconds);
    }

    if (!answer) {
      buildTimeoutReport(runDir, questionPath, config.qa_timeout_seconds, `${role}/${phase}`);
      throw new QATimeoutError(
        `Q&A timeout after ${config.qa_timeout_seconds}s for ${path.basename(questionPath)}`
      );
    }

    answers.push(answer);
  }

  return answers;
}

function loadTemplate(templateName) {
  const templatePath = path.join(TEMPLATES_DIR, templateName);
  if (!fileExists(templatePath)) {
    return "";
  }
  return readFile(templatePath);
}

async function runPlanningLoop(context) {
  const { runDir, story, config, paths } = context;
  const storyContent = readFile(paths.storyMdPath);
  const planTemplate = loadTemplate("plan.md.tpl");
  const planReviewTemplate = loadTemplate("plan_review.md.tpl");

  let attempt = 1;
  let plannerFeedback = "";

  while (attempt <= MAX_LOOP_ATTEMPTS) {
    log("planning", `Planner attempt ${attempt}`);
    const plannerResponse = await callAgent(
      "planner",
      {
        story_id: story.id,
        story_slug: story.slug,
        story_markdown: storyContent,
        attempt,
        previous_review_feedback: plannerFeedback,
        output_template: planTemplate,
        instruction: "Always ask explicit decision questions if anything is unclear.",
      },
      null
    );
    writeFile(paths.planPath, plannerResponse.content);

    await handleQnA({
      runDir,
      decisionQuestions: plannerResponse.decision_questions,
      config,
      role: "planner",
      phase: "planning",
    });

    const reviewerResponse = await callAgent(
      "plan_reviewer",
      {
        story_id: story.id,
        attempt,
        plan_markdown: plannerResponse.content,
        output_template: planReviewTemplate,
      },
      null
    );
    writeFile(paths.planReviewPath, reviewerResponse.content);

    await handleQnA({
      runDir,
      decisionQuestions: reviewerResponse.decision_questions,
      config,
      role: "plan_reviewer",
      phase: "planning_review",
    });

    runValidator(runDir, "planning");

    const verdict = readVerdict(paths.planReviewPath);
    if (verdict === "PASS") {
      log("planning", "Plan review passed");
      return readFile(paths.planPath);
    }

    plannerFeedback = reviewerResponse.content;
    attempt += 1;
  }

  throw new WorkflowError(`Planning loop exceeded ${MAX_LOOP_ATTEMPTS} attempts`, "PLANNING_LOOP_EXHAUSTED");
}

function applyImplementerPatch(response, context, label) {
  const patch = response.patch ? response.patch.trim() : "";
  if (!patch) {
    const notePath = path.join(context.runDir, "IMPLEMENTER_APPLY_TODO.md");
    const note = `# TODO: implementer patch application wiring\n\n- label: ${label}\n- timestamp: ${new Date().toISOString()}\n- reason: implementer response did not include a patch block.\n\nTODO: replace model alias / wire to real endpoint and ensure implementer output includes apply-able patch format.`;
    writeFile(notePath, `${note}\n`);
    log("implement", "No patch found in implementer output (stub/placeholder path). TODO file written.");
    return;
  }

  const patchPath = path.join(context.runDir, `implementer_patch_${Date.now()}.diff`);
  writeFile(patchPath, `${patch}\n`);

  // TODO: replace with Codex-CLI/API patch application once transport wiring is in place.
  const applyResult = runCommand("git", ["apply", "--whitespace=nowarn", patchPath], { allowFailure: true });
  if (applyResult.code !== 0) {
    const errPath = path.join(context.runDir, "implementer_patch_apply_error.log");
    writeFile(errPath, `${applyResult.stderr || applyResult.stdout}\n`);
    throw new WorkflowError(`Failed to apply implementer patch. See ${errPath}`, "PATCH_APPLY_FAILED");
  }

  log("implement", `Applied implementer patch ${path.basename(patchPath)}`);
}

async function runImplementationLoop(context, feedback = "") {
  const { runDir, story, config, paths } = context;

  const planMarkdown = readFile(paths.planPath);
  const ackTemplate = loadTemplate("dev_plan_ack.md.tpl");

  log("implementation", "Running planning readback");
  const ackResponse = await callAgent(
    "implementer",
    {
      mode: "planning_readback",
      story_id: story.id,
      plan_markdown: planMarkdown,
      extra_feedback: feedback,
      output_template: ackTemplate,
      instruction: "Ask explicitly if anything is unclear.",
    },
    null
  );
  writeFile(paths.devPlanAckPath, ackResponse.content);

  await handleQnA({
    runDir,
    decisionQuestions: ackResponse.decision_questions,
    config,
    role: "implementer",
    phase: "planning_readback",
  });

  log("implementation", "Running implementation step");
  const implResponse = await callAgent(
    "implementer",
    {
      mode: "implementation",
      story_id: story.id,
      plan_markdown: planMarkdown,
      extra_feedback: feedback,
      instruction:
        "Apply edits in working tree via patch output. TODO: transport must wire output to real Codex CLI/API patch application.",
    },
    null
  );

  const implOutputPath = path.join(runDir, `implementer_output_${Date.now()}.md`);
  writeFile(implOutputPath, implResponse.content);

  await handleQnA({
    runDir,
    decisionQuestions: implResponse.decision_questions,
    config,
    role: "implementer",
    phase: "implementation",
  });

  applyImplementerPatch(implResponse, context, "implementation");
}

function getCombinedUncommittedDiff() {
  const unstaged = runCommand("git", ["diff"], { allowFailure: true });
  const staged = runCommand("git", ["diff", "--cached"], { allowFailure: true });

  const chunks = [];
  if (unstaged.stdout.trim()) {
    chunks.push("# UNSTAGED_DIFF\n", unstaged.stdout.trim());
  }
  if (staged.stdout.trim()) {
    chunks.push("# STAGED_DIFF\n", staged.stdout.trim());
  }
  return chunks.join("\n\n").trim();
}

function getCombinedDiffStat() {
  const unstaged = runCommand("git", ["diff", "--stat"], { allowFailure: true });
  const staged = runCommand("git", ["diff", "--cached", "--stat"], { allowFailure: true });

  const chunks = [];
  if (unstaged.stdout.trim()) {
    chunks.push("# UNSTAGED_DIFF_STAT", unstaged.stdout.trim());
  }
  if (staged.stdout.trim()) {
    chunks.push("# STAGED_DIFF_STAT", staged.stdout.trim());
  }
  return chunks.join("\n\n").trim();
}

async function runDiffReview(context) {
  const { runDir, story, config, paths } = context;
  const diffTemplate = loadTemplate("diff_review.md.tpl");
  const planMarkdown = readFile(paths.planPath);

  let attempt = 1;
  while (attempt <= MAX_LOOP_ATTEMPTS) {
    log("diff-review", `Diff review attempt ${attempt}`);

    const diff = getCombinedUncommittedDiff();
    const response = await callAgent(
      "diff_reviewer",
      {
        story_id: story.id,
        plan_markdown: planMarkdown,
        diff,
        output_template: diffTemplate,
      },
      null
    );

    writeFile(paths.diffReviewPath, response.content);

    await handleQnA({
      runDir,
      decisionQuestions: response.decision_questions,
      config,
      role: "diff_reviewer",
      phase: "diff_review",
    });

    runValidator(runDir, "diff");

    const verdict = readVerdict(paths.diffReviewPath);
    if (verdict === "PASS") {
      log("diff-review", "Diff review passed");
      return;
    }

    log("diff-review", "Diff review blocked; requesting implementer fixes");
    await runImplementationLoop(context, response.content);
    attempt += 1;
  }

  throw new WorkflowError(`Diff review loop exceeded ${MAX_LOOP_ATTEMPTS} attempts`, "DIFF_LOOP_EXHAUSTED");
}

function renderVerifyReport(results, pass) {
  const verdict = pass ? "PASS" : "FAIL";
  const jsonBlock = JSON.stringify(results, null, 2);

  return `VERDICT: ${verdict}\n\n## COMMAND_RESULTS_JSON\n\`\`\`json\n${jsonBlock}\n\`\`\`\n\n## SUMMARY\n- verification_commands were read from .codex-workflow/config.yaml\n- Executed sequentially in listed order\n- Final verdict: ${verdict}\n`;
}

function runVerification(context) {
  const { runDir, config, paths } = context;
  const results = [];

  log("verify", `Running ${config.verification_commands.length} verification command(s) from config.yaml`);

  for (let i = 0; i < config.verification_commands.length; i += 1) {
    const command = config.verification_commands[i];
    const step = String(i + 1).padStart(2, "0");

    log("verify", `(${step}) ${command}`);

    const cmdResult = spawnSync(command, {
      cwd: REPO_ROOT,
      shell: true,
      encoding: "utf8",
    });

    const exitCode = typeof cmdResult.status === "number" ? cmdResult.status : 1;
    const stdout = cmdResult.stdout || "";
    const stderr = cmdResult.stderr || "";

    const stdoutFile = path.join(runDir, `verify_${step}.stdout.log`);
    const stderrFile = path.join(runDir, `verify_${step}.stderr.log`);
    writeFile(stdoutFile, stdout);
    writeFile(stderrFile, stderr);

    results.push({
      command,
      exit_code: exitCode,
      stdout_file: path.basename(stdoutFile),
      stderr_file: path.basename(stderrFile),
    });

    if (exitCode !== 0) {
      log("verify", `Command failed at step ${step}`);
      break;
    }
  }

  const pass = results.length === config.verification_commands.length && results.every((item) => item.exit_code === 0);
  const report = renderVerifyReport(results, pass);
  writeFile(paths.verifyReportPath, report);

  return {
    pass,
    results,
    report,
  };
}

function parseSection(text, startLabel, stopLabels) {
  const start = text.indexOf(startLabel);
  if (start < 0) {
    return "";
  }

  const from = start + startLabel.length;
  let to = text.length;
  for (const stop of stopLabels) {
    const idx = text.indexOf(stop, from);
    if (idx >= 0) {
      to = Math.min(to, idx);
    }
  }

  return text.slice(from, to).trim();
}

function parsePublishSummary(summaryText, story) {
  const commitTitleMatch = summaryText.match(/^COMMIT_TITLE:\s*(.+)$/m);
  const prTitleMatch = summaryText.match(/^PR_TITLE:\s*(.+)$/m);

  const commitTitle = commitTitleMatch
    ? commitTitleMatch[1].trim()
    : `feat(${story.id}-${story.slug}): implement story changes`;

  const commitBody = parseSection(summaryText, "COMMIT_BODY:", ["PR_TITLE:"]) ||
    "- Apply orchestrated story changes";

  const prTitle = prTitleMatch
    ? prTitleMatch[1].trim()
    : `[Story ${story.id}] ${story.slug}`;

  const prBody = parseSection(summaryText, "PR_BODY:", ["## DECISION_QUESTIONS_JSON", "DECISION_QUESTIONS_JSON"]) ||
    "Automated workflow update.";

  return {
    commitTitle,
    commitBody,
    prTitle,
    prBody,
  };
}

function hasStagedChanges() {
  const result = runCommand("git", ["diff", "--cached", "--quiet"], { allowFailure: true });
  if (result.code === 0) {
    return false;
  }
  if (result.code === 1) {
    return true;
  }
  throw new WorkflowError(`Unable to determine staged changes (exit ${result.code})`);
}

function stageChangesExcludingRuns() {
  runCommand("git", ["add", "-A"]);

  runCommand("git", ["restore", "--staged", ".codex-workflow/runs"], { allowFailure: true });
  runCommand("git", ["restore", "--staged", ".codex-workflow/runs/*"], { allowFailure: true });

  // Fallback for older git versions where restore may not support some paths.
  runCommand("git", ["reset", "HEAD", ".codex-workflow/runs"], { allowFailure: true });
}

function buildPublisherInput(paths) {
  const story = fileExists(paths.storyMdPath) ? readFile(paths.storyMdPath) : "";
  const plan = fileExists(paths.planPath) ? readFile(paths.planPath) : "";
  const diffReview = fileExists(paths.diffReviewPath) ? readFile(paths.diffReviewPath) : "";
  const verifyReport = fileExists(paths.verifyReportPath) ? readFile(paths.verifyReportPath) : "";
  const diffStat = getCombinedDiffStat();

  return {
    story,
    plan,
    diff_review: diffReview,
    verify_report: verifyReport,
    diff_stat: diffStat,
    publish_template: loadTemplate("publish_summary.md.tpl"),
  };
}

async function runPublisher(context) {
  const { runDir, story, config, branchName, paths } = context;
  const publisherInput = buildPublisherInput(paths);

  const response = await callAgent(
    "publisher",
    {
      story_id: story.id,
      story_slug: story.slug,
      ...publisherInput,
    },
    null
  );

  const summary = response.content || "";
  writeFile(paths.publishSummaryPath, summary);

  await handleQnA({
    runDir,
    decisionQuestions: response.decision_questions,
    config,
    role: "publisher",
    phase: "publish",
  });

  const parsed = parsePublishSummary(summary, story);

  // Exact commit behavior:
  // 1) Stage all current working-tree changes.
  // 2) Unstage run artifacts under .codex-workflow/runs.
  // 3) Create one commit using COMMIT_TITLE/COMMIT_BODY from publish_summary.md.
  stageChangesExcludingRuns();

  if (!hasStagedChanges()) {
    log("publish", "No staged changes after excluding run artifacts; skipping commit/push/PR.");
    return;
  }

  runCommand("git", ["commit", "-m", parsed.commitTitle, "-m", parsed.commitBody]);
  log("publish", "Committed changes from working tree");

  runCommand("bash", [GIT_HELPERS_PATH, "push-branch", branchName]);
  log("publish", `Pushed branch ${branchName}`);

  if (!config.use_gh_cli) {
    throw new WorkflowError("use_gh_cli is false. TODO: add non-gh PR transport if required.", "PUBLISH_CONFIG_ERROR");
  }

  const prTitlePath = path.join(runDir, "_pr_title.txt");
  const prBodyPath = path.join(runDir, "_pr_body.md");
  writeFile(prTitlePath, `${parsed.prTitle}\n`);
  writeFile(prBodyPath, `${parsed.prBody}\n`);

  const prResult = runCommand(
    "bash",
    [GIT_HELPERS_PATH, "create-or-update-pr", branchName, config.pr_target, prTitlePath, prBodyPath],
    { allowFailure: true }
  );

  if (prResult.code !== 0) {
    throw new WorkflowError(`Failed to create/update PR via gh: ${prResult.stderr || prResult.stdout}`, "PR_ERROR");
  }

  const prRef = (prResult.stdout || "").trim().split(/\r?\n/).pop();
  if (!prRef) {
    throw new WorkflowError("PR reference missing from create-or-update-pr output", "PR_ERROR");
  }

  log("publish", `PR ready: ${prRef}`);

  if (config.required_checks === "all_required") {
    const ciTimeout = Number(config.ci_timeout_seconds || DEFAULT_CI_TIMEOUT_SECONDS);
    const checkResult = runCommand(
      "bash",
      [GIT_HELPERS_PATH, "wait-required-checks", prRef, `${ciTimeout}`],
      { allowFailure: true }
    );

    if (checkResult.code !== 0) {
      const reason = checkResult.code === 124 ? "timeout" : "failed";
      const note = `CI required checks ${reason} for ${prRef}. Stopping without auto-merge.`;

      runCommand(
        "bash",
        [GIT_HELPERS_PATH, "annotate-pr", prRef, note],
        { allowFailure: true }
      );

      throw new WorkflowError(note, "CI_CHECKS_ERROR");
    }

    log("publish", "All required status checks are green");
  }

  log("publish", "Publish flow completed (no auto-merge by design)");
}

async function runStory(config, story) {
  const paths = createRunFolder(story);
  const branchName = ensureFeatureBranch(story, config);

  const context = {
    story,
    config,
    branchName,
    runDir: paths.runDir,
    paths,
  };

  try {
    updateStoryStatus(story.id, "in_progress");

    await runPlanningLoop(context);
    await runImplementationLoop(context);

    let verificationAttempts = 0;
    while (verificationAttempts < MAX_LOOP_ATTEMPTS) {
      await runDiffReview(context);

      const verifyResult = runVerification(context);
      if (verifyResult.pass) {
        break;
      }

      verificationAttempts += 1;
      if (verificationAttempts >= MAX_LOOP_ATTEMPTS) {
        throw new WorkflowError("Verification did not pass within retry limit", "VERIFY_LOOP_EXHAUSTED");
      }

      log("verify", "Verification failed; returning to implementation loop");
      await runImplementationLoop(context, readFile(paths.verifyReportPath));
    }

    await runPublisher(context);

    updateStoryStatus(story.id, "done");
    log("done", `Story ${story.id}-${story.slug} completed`);
  } catch (error) {
    if (error instanceof QATimeoutError) {
      updateStoryStatus(story.id, "blocked", "Q&A timeout");
      throw error;
    }

    updateStoryStatus(story.id, "blocked", error.message.slice(0, 140));
    throw error;
  }
}

async function main() {
  ensureDir(RUNS_DIR);

  const config = loadConfig();
  ACTIVE_CONFIG = config;
  const story = pickNextStory();

  if (!story) {
    log("noop", "No eligible todo story found (check status/depends_on in stories.yaml)");
    return;
  }

  log("start", `Picked story ${story.id}-${story.slug}`);

  try {
    await runStory(config, story);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log("error", message);
    process.exitCode = 1;
  }
}

main();
