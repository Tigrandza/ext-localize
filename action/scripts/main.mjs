#!/usr/bin/env node
// Entry point of the ext-localize GitHub Action (composite).
// All inputs come in as INPUT_* environment variables set in action.yml.
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InputError, annotation, appendSummary, boolInput, escapeMarkdown, logUntrusted, oneLine, setOutputs } from "./lib/gha.mjs";
import { installLocalCli, resolveCli, runCli } from "./lib/cli.mjs";
import { STALE_MODES, buildAnnotations, decide, renderCheckSummary, staleFlag } from "./lib/report.mjs";
import { PrBlockedError, assertEventAllowed, assertSafeTarget, defaultExec, publish } from "./lib/publish.mjs";
import { buildTranslateArgs, commitPaths, failedCount, parseStores, parseTranslateJson, renderTranslateBody } from "./lib/translate.mjs";

function readInputs(env) {
  const workspace = resolve(env.GITHUB_WORKSPACE || process.cwd());
  const mode = (env.INPUT_MODE || "check").trim();
  if (mode !== "check" && mode !== "translate") throw new InputError(`mode must be "check" or "translate", got "${mode}"`);
  const staleMode = (env.INPUT_STALE || "fail").trim();
  if (!Object.hasOwn(STALE_MODES, staleMode)) throw new InputError(`stale must be one of ${Object.keys(STALE_MODES).join(", ")}, got "${staleMode}"`);
  const root = resolve(workspace, (env.INPUT_PATH || ".").trim());
  const dirLabel = relative(workspace, root) || ".";
  if (dirLabel.startsWith("..")) throw new InputError(`path "${env.INPUT_PATH}" is outside the workspace`);
  return {
    env,
    workspace,
    mode,
    staleMode,
    root,
    dirLabel,
    strict: boolInput(env.INPUT_STRICT, false),
    annotations: boolInput(env.INPUT_ANNOTATIONS, true),
    dryRun: boolInput(env.INPUT_DRY_RUN, false),
    listing: boolInput(env.INPUT_LISTING, false),
    store: parseStores(env.INPUT_STORE),
    cliSource: env.INPUT_CLI_SOURCE,
    cliVersion: env.INPUT_CLI_VERSION,
  };
}

function prepareCli(inputs, log) {
  const cli = resolveCli({ source: inputs.cliSource, version: inputs.cliVersion, workspace: inputs.workspace });
  if (cli.installDir) {
    log(`Installing the CLI's dependencies in ${cli.installDir}`);
    installLocalCli(cli.installDir);
  }
  log(`Using CLI: ${cli.label}`);
  return cli;
}

/** Run `check --json`. Exit 0 = clean, 1 = issues found; anything else (2 = usage/setup) is a failure to run. */
export function runCheckJson(cli, inputs) {
  const args = ["check", `--dir=${inputs.root}`, "--json", staleFlag(inputs.staleMode)];
  if (inputs.store) args.push(`--store=${inputs.store}`);
  const r = runCli(cli, args, { cwd: inputs.workspace, env: inputs.env });
  if (r.status === 0 || r.status === 1) {
    try {
      const report = JSON.parse(r.stdout);
      if (report && Array.isArray(report.issues)) return { report, raw: r };
    } catch {
      /* fall through */
    }
  }
  return { report: null, raw: r };
}

export function modeCheck(inputs, cli, { log = console.log } = {}) {
  const { report, raw } = runCheckJson(cli, inputs);
  if (!report) {
    logUntrusted([raw.stdout, raw.stderr].filter((x) => x.trim()).join("\n"), log);
    appendSummary(`## ❌ ext-localize check could not run\n\nExit code ${raw.status}. See the step log.\n`, inputs.env);
    setOutputs({ result: "error", errors: "", warnings: "", stale: "" }, inputs.env);
    return 1;
  }
  const decision = decide({ report, strict: inputs.strict });
  const sc = report.staleCheck;

  // Human-readable log. Text from the repo is kept on one line.
  for (const issue of report.issues) {
    const where = `${issue.file ?? issue.locale ?? "manifest"}${issue.line ? `:${issue.line}` : ""}${issue.key ? ` > ${issue.key}` : ""}`;
    log(oneLine(`${(issue.kind === "stale" ? "STALE" : issue.level.toUpperCase()).padEnd(7)} ${where}: ${issue.message}`));
  }
  log(`${report.locales.length} locale(s): ${report.errors} error(s), ${report.warnings} warning(s), stale: ${sc?.status === "ok" ? report.stale : (sc?.status ?? "unknown")}.`);
  if (sc && sc.status !== "ok" && sc.status !== "off" && sc.note) log(oneLine(sc.note));

  let dropped = 0;
  if (inputs.annotations) {
    const a = buildAnnotations({ report, strict: inputs.strict, dirLabel: inputs.dirLabel });
    for (const line of a.lines) log(line);
    dropped = a.dropped;
  }
  appendSummary(renderCheckSummary({ report, strict: inputs.strict, decision, dirLabel: inputs.dirLabel, droppedAnnotations: dropped }), inputs.env);
  setOutputs(
    {
      result: decision.failed ? "fail" : "pass",
      errors: String(report.errors),
      warnings: String(report.warnings),
      stale: sc?.status === "ok" ? String(report.stale ?? 0) : "",
    },
    inputs.env,
  );
  if (decision.failed) log(`Failed: ${decision.reasons.join(", ")}.`);
  return decision.failed ? 1 : 0;
}

function lookupDefaultBranch(env, exec = defaultExec) {
  const r = exec("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], { cwd: env.GITHUB_WORKSPACE, env });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** One `translate --json` run. A run "failed hard" when it gave no result or an error result. */
function runTranslate(cli, inputs, target, log) {
  const env = inputs.env;
  const args = buildTranslateArgs({
    dir: inputs.root,
    provider: env.INPUT_PROVIDER,
    to: env.INPUT_TO,
    model: env.INPUT_MODEL,
    formality: env.INPUT_FORMALITY,
    store: inputs.store,
    dryRun: inputs.dryRun,
    listing: target === "listing",
  });
  log(`Running: ext-localize ${args.join(" ")}`);
  const r = runCli(cli, args, { cwd: inputs.workspace, env });
  // stdout is the JSON result, stderr the progress lines.
  if (r.stderr.trim()) logUntrusted(r.stderr.trimEnd(), log);
  const json = parseTranslateJson(r.stdout);
  if (!json && r.stdout.trim()) logUntrusted(r.stdout.trimEnd(), log);
  const hardError = !json || Boolean(json.error) || r.status === 2 || ![0, 1, 3].includes(r.status);
  return { target, exitCode: r.status, json, stderr: r.stderr, hardError };
}

/** Overall result of all runs: error, partial, no-targets or pass. */
export function translateOutcome(runs) {
  if (runs.some((r) => r.hardError)) return "error";
  if (runs.some((r) => r.exitCode === 1)) return "partial";
  if (runs.every((r) => r.exitCode === 3)) return "no-targets";
  return "pass";
}

export function modeTranslate(inputs, cli, { log = console.log, exec } = {}) {
  const env = inputs.env;
  const provider = (env.INPUT_PROVIDER || "").trim();
  const branch = (env.INPUT_BRANCH || "ext-localize/translations").trim();
  let defaultBranch = (env.DEFAULT_BRANCH || "").trim();
  let base = (env.INPUT_BASE || "").trim();
  if (!inputs.dryRun) {
    assertEventAllowed(env.GITHUB_EVENT_NAME);
    // Some events (for example schedule) carry no repository info: ask GitHub.
    if (!defaultBranch) defaultBranch = lookupDefaultBranch(env, exec);
    base ||= defaultBranch;
    if (!base) throw new InputError(`could not tell the base branch. Set the "base" input.`);
    // Check before spending money on translation.
    assertSafeTarget({ branch, base, defaultBranch, currentRef: env.GITHUB_REF_NAME });
  }

  // Messages first: the listing copies name and summary from _locales.
  const runs = [runTranslate(cli, inputs, "messages", log)];
  if (inputs.listing && !runs[0].hardError) runs.push(runTranslate(cli, inputs, "listing", log));
  const outcome = translateOutcome(runs);

  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  const body = renderTranslateBody({ runs, provider, dirLabel: inputs.dirLabel, runUrl });
  const exitCode = outcome === "error" || outcome === "partial" ? 1 : 0;

  if (inputs.dryRun) {
    appendSummary(`## ${exitCode ? "❌" : "✅"} ext-localize translate (dry run)\n\n${body}\n`, env);
    setOutputs({ result: outcome === "error" ? "error" : "dry-run", changed: "false", "pr-url": "", "pr-number": "" }, env);
    return exitCode;
  }

  // Commit what was written, even if a later run failed: the strings are paid for.
  const paths = commitPaths(runs);
  let pub;
  try {
    pub = publish({
      root: inputs.root,
      paths,
      branch,
      base,
      defaultBranch,
      currentRef: env.GITHUB_REF_NAME,
      title: (env.INPUT_PR_TITLE || "").trim() || "Update translations (ext-localize)",
      commitMessage: "Update translations (ext-localize)",
      body,
      env,
      exec,
    });
  } catch (e) {
    if (!(e instanceof PrBlockedError)) throw e;
    return reportPrBlocked({ branch, base, body, env, log, detail: e.detail });
  }

  let heading;
  if (pub.changed) heading = `## ${exitCode ? "⚠️" : "✅"} ext-localize translate: PR ${pub.action} — ${pub.url ?? ""}`;
  else if (outcome === "error") heading = "## ❌ ext-localize translate failed. Nothing was committed.";
  else if (outcome === "no-targets") heading = "## ✅ ext-localize translate: no target locales, nothing to do";
  else heading = "## ✅ ext-localize translate: nothing to change";
  log(
    pub.changed
      ? `Pull request ${pub.action}: ${pub.url} (${paths.length} file(s)).`
      : outcome === "no-targets"
        ? `No target locales: nothing to do. Set the "to" input to choose locales.`
        : "No translation changes. No pull request needed.",
  );
  if (outcome === "partial") log(`${failedCount(runs)} string(s) failed. See the job summary.`);
  appendSummary(`${heading}\n\n${body}\n`, env);
  setOutputs(
    {
      result: outcome,
      changed: String(pub.changed),
      "pr-url": pub.url ?? "",
      "pr-number": pub.number ? String(pub.number) : "",
    },
    env,
  );
  // Some strings failed or a run broke: the PR has what worked, but the job shows red.
  return exitCode;
}

/** Where to turn on PR creation, as one text for the log, the annotation and the summary. */
export const PR_SETTING = 'Settings > Actions > General > Workflow permissions > "Allow GitHub Actions to create and approve pull requests"';

/**
 * The branch was pushed, but GitHub refused to open the PR (repo or org setting).
 * The job fails with a clear fix; the strings are safe on the branch.
 */
export function reportPrBlocked({ branch, base, body, env, log, detail }) {
  const compareUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/compare/${encodeURIComponent(base)}...${branch.split("/").map(encodeURIComponent).join("/")}?expand=1`
      : "";
  const message =
    `The translations were pushed to branch "${branch}", but GitHub did not allow the Action to open a pull request. ` +
    `Turn on ${PR_SETTING} and run the workflow again. ` +
    `In an organization repo, the same setting at the organization level may also block it.` +
    (compareUrl ? ` You can also open the PR by hand: ${compareUrl}` : "");
  log(annotation("error", { title: "ext-localize: pull request not allowed" }, message));
  if (detail) logUntrusted(`gh said: ${oneLine(detail)}`, log);
  const summary = [
    "## ❌ ext-localize translate: branch pushed, but GitHub blocked the pull request",
    "",
    `The translations are on branch \`${escapeMarkdown(branch)}\`. GitHub did not allow the Action to open the pull request.`,
    "",
    "**Fix:** in the repository, turn on",
    `${escapeMarkdown(PR_SETTING)}, then run the workflow again.`,
    "For a repository in an organization, the organization setting may also need to allow it.",
    ...(compareUrl ? ["", `Or open the pull request by hand: ${compareUrl}`] : []),
    "",
    body,
    "",
  ].join("\n");
  appendSummary(summary, env);
  setOutputs({ result: "pr-blocked", changed: "true", "pr-url": "", "pr-number": "" }, env);
  return 1;
}

export function main(env = process.env) {
  try {
    const inputs = readInputs(env);
    const cli = prepareCli(inputs, console.log);
    return inputs.mode === "check" ? modeCheck(inputs, cli) : modeTranslate(inputs, cli);
  } catch (e) {
    const msg = e instanceof InputError ? `Input error: ${e.message}` : `Error: ${e.message}`;
    console.log(`::error title=ext-localize::${msg.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
