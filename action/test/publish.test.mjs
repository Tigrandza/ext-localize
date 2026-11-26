import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { PrBlockedError, assertEventAllowed, assertSafeTarget, defaultExec, publish, validateBranch } from "../scripts/lib/publish.mjs";
import { GIT_ENV, git, makeRepo } from "./helpers/env.mjs";

/** Fake exec: records calls, answers from a table. */
function fakeExec(answers = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args[0]}${cmd === "gh" ? ` ${args[1]}` : ""}`;
    const a = answers[key];
    return typeof a === "function" ? a(args) : { status: 0, stdout: "", stderr: "", ...(a ?? {}) };
  };
  return { exec, calls };
}

const PATHS = [".localizer/state.json", "_locales/de/messages.json"];
const base = { root: "/w/ext", paths: PATHS, branch: "ext-localize/translations", base: "main", defaultBranch: "main", currentRef: "main", title: "T", body: "B", commitMessage: "M", env: {} };

test("validateBranch accepts normal names and rejects odd ones", () => {
  for (const ok of ["ext-localize/translations", "l10n", "bot/a.b_c-1"]) assert.equal(validateBranch(ok), ok);
  for (const bad of ["", "-x", "a..b", "a b", "refs/heads/x", "x/", "x.lock", "a//b", "a~1", "a:b"]) {
    assert.throws(() => validateBranch(bad), /not a safe branch name/, bad);
  }
});

test("assertSafeTarget refuses the default, base and current branch", () => {
  assert.throws(() => assertSafeTarget({ ...base, branch: "main" }), /default, base or current/);
  assert.throws(() => assertSafeTarget({ ...base, branch: "develop", base: "develop" }), /default, base or current/);
  assert.throws(() => assertSafeTarget({ ...base, branch: "release", base: "release", currentRef: "release" }), /default, base or current/);
  assert.throws(() => assertSafeTarget({ ...base, branch: "trunk", defaultBranch: "trunk", base: "x" }), /default, base or current/);
  assert.throws(() => assertSafeTarget({ ...base, branch: "master", defaultBranch: "trunk", base: "trunk" }), /default, base or current/);
  assertSafeTarget(base);
});

test("assertSafeTarget refuses when the checked-out branch is not the PR base", () => {
  assert.throws(() => assertSafeTarget({ ...base, currentRef: "feat" }), /runs on "feat", but the PR base is "main"/);
  assertSafeTarget({ ...base, base: "feat", currentRef: "feat" });
  assertSafeTarget({ ...base, currentRef: undefined });
});

test("translate mode refuses pull request events", () => {
  assert.throws(() => assertEventAllowed("pull_request"), /does not run on "pull_request"/);
  assert.throws(() => assertEventAllowed("pull_request_target"), /pull_request_target/);
  for (const ok of ["push", "workflow_dispatch", "schedule", undefined]) assertEventAllowed(ok);
});

test("no changes: no commit, no push, no PR", () => {
  const { exec, calls } = fakeExec({ "git status": { stdout: "" } });
  assert.deepEqual(publish({ ...base, exec }), { changed: false, action: "none" });
  assert.deepEqual(calls, [["git", "status", "--porcelain", "--", ...PATHS]]);
});

test("nothing written by the CLI: not even git status", () => {
  const { exec, calls } = fakeExec();
  assert.deepEqual(publish({ ...base, paths: [], exec }), { changed: false, action: "none" });
  assert.equal(calls.length, 0);
});

test("changes and no open PR: commit, force-push the bot branch, create PR", () => {
  const { exec, calls } = fakeExec({
    "git status": { stdout: " M _locales/de/messages.json\n" },
    "gh pr list": { stdout: "[]" },
    "gh pr create": { stdout: "https://github.com/o/r/pull/12\n" },
  });
  const r = publish({ ...base, exec });
  assert.deepEqual(r, { changed: true, action: "created", url: "https://github.com/o/r/pull/12", number: 12 });
  const cmds = calls.map((c) => c.slice(0, 3).join(" "));
  assert.deepEqual(cmds, [
    "git status --porcelain",
    "git checkout -B",
    "git add -A",
    "git commit --no-verify",
    "git push --force",
    "gh pr list",
    "gh pr create",
  ]);
  assert.deepEqual(calls[2], ["git", "add", "-A", "--", ...PATHS]);
  assert.deepEqual(calls[4], ["git", "push", "--force", "origin", "HEAD:refs/heads/ext-localize/translations"]);
  assert.deepEqual(calls[6], ["gh", "pr", "create", "--base", "main", "--head", "ext-localize/translations", "--title", "T", "--body", "B"]);
  // Nothing is ever pushed to main.
  assert.ok(!calls.some((c) => c.join(" ").includes("refs/heads/main")));
});

test("changes and an open PR: update it instead of opening another", () => {
  const { exec, calls } = fakeExec({
    "git status": { stdout: " M _locales/de/messages.json\n" },
    "gh pr list": { stdout: '[{"number":5,"url":"https://github.com/o/r/pull/5"}]' },
  });
  const r = publish({ ...base, exec });
  assert.deepEqual(r, { changed: true, action: "updated", url: "https://github.com/o/r/pull/5", number: 5 });
  assert.deepEqual(calls.at(-1), ["gh", "pr", "edit", "5", "--title", "T", "--body", "B"]);
  assert.ok(!calls.some((c) => c[1] === "pr" && c[2] === "create"));
});

test("a failing push stops before any PR call, with git's message", () => {
  const { exec, calls } = fakeExec({
    "git status": { stdout: " M x\n" },
    "git push": { status: 1, stderr: "remote: Permission denied" },
  });
  assert.throws(() => publish({ ...base, exec }), /git push failed: remote: Permission denied/);
  assert.ok(!calls.some((c) => c[0] === "gh"));
});

test("GitHub blocks PR creation: a PrBlockedError that names the pushed branch", () => {
  const blocked = "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)";
  const { exec, calls } = fakeExec({
    "git status": { stdout: " M x\n" },
    "gh pr create": { status: 1, stderr: blocked },
  });
  assert.throws(
    () => publish({ ...base, exec }),
    (e) => e instanceof PrBlockedError && e.branch === "ext-localize/translations" && e.detail === blocked && /branch "ext-localize\/translations" was pushed/.test(e.message),
  );
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push"), "the branch was pushed first");
});

test("other gh pr create failures stay plain errors", () => {
  const { exec } = fakeExec({
    "git status": { stdout: " M x\n" },
    "gh pr create": { status: 1, stderr: "HTTP 502" },
  });
  assert.throws(() => publish({ ...base, exec }), (e) => !(e instanceof PrBlockedError) && /gh pr create failed: HTTP 502/.test(e.message));
});

test("unsafe branch is refused before any git call", () => {
  const { exec, calls } = fakeExec();
  assert.throws(() => publish({ ...base, branch: "main", exec }));
  assert.equal(calls.length, 0);
});

test("real git: commits only the CLI's files and pushes the bot branch, main untouched", (t) => {
  const repo = makeRepo(t);
  const mainBefore = git(repo.remote, ["rev-parse", "refs/heads/main"]).trim();
  // What translate writes ...
  writeFileSync(join(repo.ext, "_locales", "en", "messages.json"), '{"a":{"message":"x"}}\n');
  writeFileSync(join(repo.ext, ".localizer", "state.json"), "{}\n");
  // ... and an unrelated change that must not be committed.
  writeFileSync(join(repo.ext, "manifest.json"), "{}\n");
  writeFileSync(join(repo.work, "notes.txt"), "x\n");

  const env = { ...process.env, ...GIT_ENV };
  const exec = (cmd, args, opts) =>
    cmd === "gh"
      ? args[1] === "list"
        ? { status: 0, stdout: "[]", stderr: "" }
        : { status: 0, stdout: "https://github.com/o/r/pull/1\n", stderr: "" }
      : defaultExec(cmd, args, opts);
  const paths = ["_locales/en/messages.json", ".localizer/state.json"];
  const r = publish({ ...base, paths, root: repo.ext, env, exec });
  assert.equal(r.action, "created");

  assert.equal(git(repo.remote, ["rev-parse", "refs/heads/main"]).trim(), mainBefore);
  const files = git(repo.remote, ["show", "--name-only", "--format=", "refs/heads/ext-localize/translations"]).trim().split("\n").sort();
  assert.deepEqual(files, ["ext/.localizer/state.json", "ext/_locales/en/messages.json"]);
  const author = git(repo.remote, ["log", "-1", "--format=%an <%ae>", "refs/heads/ext-localize/translations"]).trim();
  assert.equal(author, "github-actions[bot] <41898583+github-actions[bot]@users.noreply.github.com>");

  // Second run with new changes force-updates the same branch (one commit on top of main).
  // (a fresh runner starts on main again)
  git(repo.work, ["checkout", "-q", "-f", "main"]);
  writeFileSync(join(repo.ext, ".localizer", "state.json"), '{"v":3}\n');
  publish({ ...base, paths, root: repo.ext, env, exec });
  const count = git(repo.remote, ["rev-list", "--count", `${mainBefore}..refs/heads/ext-localize/translations`]).trim();
  assert.equal(count, "1");
});
