// Commit translated files to a bot branch and open or update one pull request.
// Uses only git and the gh CLI, which are on GitHub-hosted runners.
//
// Safety rules:
// - Never push to the default branch, the PR base, or the branch the workflow runs on.
// - Only stage the files the CLI reports it wrote (filesWritten, checked against its mayWrite list).
// - Push to an explicit refs/heads/<branch>, so a tag with the same name cannot be hit.
import { spawnSync } from "node:child_process";
import { InputError } from "./gha.mjs";

export const BOT_NAME = "github-actions[bot]";
export const BOT_EMAIL = "41898583+github-actions[bot]@users.noreply.github.com";

/** Events where translate mode must not run (code from a PR, maybe from a fork). */
const BLOCKED_EVENTS = new Set(["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment"]);

export function assertEventAllowed(eventName) {
  if (BLOCKED_EVENTS.has(eventName)) {
    throw new InputError(
      `mode: translate does not run on "${eventName}" events. Use it on push, workflow_dispatch or schedule. Use mode: check for pull requests.`,
    );
  }
}

/** A conservative subset of valid git branch names. */
export function validateBranch(name) {
  const ok =
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock") &&
    !name.startsWith("refs/");
  if (!ok) throw new InputError(`branch "${name}" is not a safe branch name. Use letters, digits, ".", "_", "-" and "/".`);
  return name;
}

/** The bot branch must never be a branch people work on. */
export function assertSafeTarget({ branch, base, defaultBranch, currentRef }) {
  validateBranch(branch);
  const protectedNames = [base, defaultBranch, currentRef, "main", "master"].filter(Boolean);
  if (protectedNames.includes(branch)) {
    throw new InputError(
      `branch "${branch}" is the default, base or current branch. The Action only pushes to its own branch (default: ext-localize/translations).`,
    );
  }
  // The bot branch is built on top of the checked-out commit. If that is not the
  // base, the PR would also carry every other commit of the current branch.
  if (currentRef && base && currentRef !== base) {
    throw new InputError(
      `the workflow runs on "${currentRef}", but the PR base is "${base}". Run translate on "${base}", or set the "base" input to "${currentRef}".`,
    );
  }
}

/** GitHub's repo (or org) setting blocks PRs made with GITHUB_TOKEN. */
export const PR_BLOCKED_RE = /not permitted to create or approve pull requests/i;

/** The branch was pushed, but GitHub refused to open the pull request. */
export class PrBlockedError extends Error {
  constructor(branch, detail) {
    super(`GitHub Actions is not permitted to create pull requests in this repository (branch "${branch}" was pushed)`);
    this.name = "PrBlockedError";
    this.branch = branch;
    this.detail = detail;
  }
}

export function defaultExec(command, args, opts = {}) {
  const r = spawnSync(command, args, { encoding: "utf8", ...opts });
  if (r.error) return { status: 1, stdout: "", stderr: r.error.message };
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function must(result, what) {
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${what} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

/**
 * @param {object} o
 * @param {string} o.root        extension folder (cwd for git; pathspecs are relative to it)
 * @param {string[]} o.paths     files to commit, relative to root (from commitPaths)
 * @param {string} o.branch      bot branch
 * @param {string} o.base        PR base branch
 * @param {string} [o.defaultBranch]
 * @param {string} [o.currentRef] branch the workflow runs on (GITHUB_REF_NAME)
 * @param {string} o.title       PR title
 * @param {string} o.body        PR body (markdown)
 * @param {string} o.commitMessage
 * @param {Record<string,string>} o.env  env for git/gh (needs GH_TOKEN for gh)
 * @param {Function} [o.exec]    (command, args, opts) => {status, stdout, stderr}
 * @returns {{changed: boolean, action: "none"|"created"|"updated", url?: string, number?: number}}
 */
export function publish(o) {
  const exec = o.exec ?? defaultExec;
  assertSafeTarget(o);
  const paths = o.paths ?? [];
  if (paths.length === 0) return { changed: false, action: "none" };
  const git = (args, what) => must(exec("git", args, { cwd: o.root, env: o.env }), what ?? `git ${args[0]}`);
  const gh = (args, what) => must(exec("gh", args, { cwd: o.root, env: o.env }), what ?? `gh ${args.slice(0, 2).join(" ")}`);

  const status = git(["status", "--porcelain", "--", ...paths]).stdout.trim();
  if (!status) return { changed: false, action: "none" };

  git(["checkout", "-B", o.branch]);
  git(["add", "-A", "--", ...paths]);
  // Bot identity through env: it wins over git config and over GIT_AUTHOR_* set earlier in the job.
  const botEnv = { ...(o.env ?? process.env), GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL, GIT_COMMITTER_NAME: BOT_NAME, GIT_COMMITTER_EMAIL: BOT_EMAIL };
  must(exec("git", ["commit", "--no-verify", "-m", o.commitMessage], { cwd: o.root, env: botEnv }), "git commit");
  // The bot branch is rebuilt from the base on every run, so a force push is expected.
  git(["push", "--force", "origin", `HEAD:refs/heads/${o.branch}`]);

  const listed = gh(["pr", "list", "--head", o.branch, "--base", o.base, "--state", "open", "--json", "number,url", "--limit", "1"]);
  let existing;
  try {
    existing = JSON.parse(listed.stdout || "[]")[0];
  } catch {
    throw new Error(`gh pr list returned output that is not JSON: ${listed.stdout.slice(0, 200)}`);
  }
  if (existing) {
    gh(["pr", "edit", String(existing.number), "--title", o.title, "--body", o.body], "gh pr edit");
    return { changed: true, action: "updated", url: existing.url, number: existing.number };
  }
  const createArgs = ["pr", "create", "--base", o.base, "--head", o.branch, "--title", o.title, "--body", o.body];
  const attempt = exec("gh", createArgs, { cwd: o.root, env: o.env });
  if (attempt.status !== 0 && PR_BLOCKED_RE.test(`${attempt.stderr}\n${attempt.stdout}`)) {
    throw new PrBlockedError(o.branch, (attempt.stderr || attempt.stdout || "").trim());
  }
  const created = must(attempt, "gh pr create");
  const url = created.stdout.trim().split(/\s+/).pop();
  const number = Number(url?.match(/\/pull\/(\d+)/)?.[1]) || undefined;
  return { changed: true, action: "created", url, number };
}
