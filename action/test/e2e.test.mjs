// End to end: the real ext-localize CLI (from ../cli, read-only) on a copy of
// cli/fixtures/sample-extension, inside a throwaway git repo in the OS temp
// folder with a bare "origin". Translation uses the CLI's openai provider
// pointed at a fake server on 127.0.0.1. `gh` is a fake script on PATH.
// No paid API is called, nothing outside the temp folder is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_DIR, copyFixture, fakeGh, git, makeRepo, readGhLog, readJson, runAction, startFakeOpenAI, tempDir } from "./helpers/env.mjs";
import { canStripTypes } from "../scripts/lib/cli.mjs";

const SECRET = "sk-test-not-a-real-key-4242";

if (!canStripTypes() && !existsSync(join(CLI_DIR, "dist", "cli.js"))) {
  test("e2e", (t) => t.skip("this Node cannot run cli/src/cli.ts and cli/dist is missing"));
} else {
  test("check: clean fixture passes; stale is reported as not checked (no state yet)", async (t) => {
    const ws = tempDir(t);
    copyFixture(join(ws, "ext"));
    const r = await runAction({ workspace: ws, inputs: { mode: "check", path: "ext" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.result, "pass");
    assert.equal(r.outputs.errors, "0");
    assert.equal(r.outputs.stale, "");
    assert.match(r.summary, /## ✅ ext-localize check/);
    assert.match(r.summary, /not checked/);
  });

  test("translate dry-run: no API calls, nothing written, summary has the plan", async (t) => {
    const ws = tempDir(t);
    copyFixture(join(ws, "ext"));
    const server = await startFakeOpenAI(t);
    const r = await runAction({ workspace: ws, inputs: { mode: "translate", path: "ext", "dry-run": "true", to: "de,fr" }, env: { OPENAI_BASE_URL: server.url } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.result, "dry-run");
    assert.equal(server.requests.length, 0);
    assert.equal(existsSync(join(ws, "ext", "_locales", "de")), false);
    assert.match(r.summary, /dry run/);
    assert.match(r.summary, /\| de \| 25 \| 0 \|/);
  });

  test("full flow: translate opens a PR, check passes, a source edit makes it stale, a broken placeholder is an error, re-run updates the PR", async (t) => {
    const repo = makeRepo(t);
    const server = await startFakeOpenAI(t);
    const bin = join(repo.base, "bin");
    const ghLog = join(repo.base, "gh.log");
    fakeGh(bin, ghLog);
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      OPENAI_BASE_URL: server.url,
      OPENAI_API_KEY: SECRET,
      GH_TOKEN: "fake-token",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF_NAME: "main",
      DEFAULT_BRANCH: "main",
    };
    const translateInputs = { mode: "translate", path: "ext", provider: "openai", model: "fake-model", to: "de,fr" };

    // 1. translate -> PR created
    const tr = await runAction({ workspace: repo.work, inputs: translateInputs, env });
    assert.equal(tr.status, 0, tr.stdout + tr.stderr);
    assert.equal(tr.outputs.result, "pass");
    assert.equal(tr.outputs.changed, "true");
    assert.equal(tr.outputs["pr-url"], "https://github.com/owner/repo/pull/7");
    assert.equal(tr.outputs["pr-number"], "7");
    assert.ok(server.requests.length >= 2);
    assert.ok(server.requests.every((q) => q.auth === `Bearer ${SECRET}`), "provider key reaches the CLI through env");
    for (const out of [tr.stdout, tr.stderr, tr.summary]) assert.ok(!out.includes(SECRET), "key is never printed");

    const branch = "refs/heads/ext-localize/translations";
    const files = git(repo.remote, ["show", "--name-only", "--format=", branch]).trim().split("\n").sort();
    assert.deepEqual(files, ["ext/.localizer/state.json", "ext/_locales/de/messages.json", "ext/_locales/fr/messages.json"]);
    const mainHead = git(repo.remote, ["rev-parse", "refs/heads/main"]).trim();
    assert.equal(git(repo.remote, ["rev-parse", `${branch}~1`]).trim(), mainHead, "one commit on top of main; main untouched");
    const deFile = JSON.parse(git(repo.remote, ["show", `${branch}:ext/_locales/de/messages.json`]));
    assert.equal(deFile.sessionSaved.message, '[de] Saved $count$ tabs to "$session_name$".');

    let gh = readGhLog(ghLog);
    const create = gh.find((c) => c.args[1] === "create");
    assert.ok(create, "gh pr create was called");
    assert.equal(create.token, "set");
    const body = create.args[create.args.indexOf("--body") + 1];
    assert.match(body, /\| Locale \| New \| Changed/);
    assert.match(body, /\| de \| 25 \| 0 \| 0 \| 0 \| 0 \| 25 \| 0 \|/);
    assert.match(body, /found 0 error\(s\)/);

    // 2. check on the translated tree -> pass, 0 stale
    const ok = await runAction({ workspace: repo.work, inputs: { mode: "check", path: "ext" } });
    assert.equal(ok.status, 0, ok.stdout);
    assert.equal(ok.outputs.stale, "0");

    // 3. the source text of one key changes -> stale in de and fr
    const enPath = join(repo.ext, "_locales", "en", "messages.json");
    const en = readJson(enPath);
    en.buttonRestore.message = "Restore now";
    en.extName.description = "only the description changed: not stale";
    writeFileSync(enPath, JSON.stringify(en, null, 2) + "\n");

    const fail = await runAction({ workspace: repo.work, inputs: { mode: "check", path: "ext" } });
    assert.equal(fail.status, 1);
    assert.equal(fail.outputs.result, "fail");
    assert.equal(fail.outputs.stale, "2");
    assert.match(fail.stdout, /::error file=ext\/_locales\/de\/messages\.json,line=\d+,title=ext-localize::de > buttonRestore: source changed/);
    assert.match(fail.summary, /\| de \| buttonRestore \|/);
    assert.match(fail.summary, /\*\*Failed:\*\* 2 stale string\(s\)\./);

    const warn = await runAction({ workspace: repo.work, inputs: { mode: "check", path: "ext", stale: "warn" } });
    assert.equal(warn.status, 0);
    assert.equal(warn.outputs.stale, "2");
    assert.match(warn.stdout, /::warning file=ext\/_locales\/fr\/messages\.json,line=\d+,title=ext-localize::fr > buttonRestore: source changed/);
    const ignore = await runAction({ workspace: repo.work, inputs: { mode: "check", path: "ext", stale: "ignore" } });
    assert.equal(ignore.status, 0);
    assert.doesNotMatch(ignore.stdout, /source changed/);
    assert.equal(ignore.outputs.stale, "");

    // 4. a broken placeholder in de -> error, whatever the stale setting
    const dePath = join(repo.ext, "_locales", "de", "messages.json");
    const de = readJson(dePath);
    de.sessionSaved.message = "[de] Gespeichert: Tabs";
    writeFileSync(dePath, JSON.stringify(de, null, 2) + "\n");
    const broken = await runAction({ workspace: repo.work, inputs: { mode: "check", path: "ext", stale: "ignore" } });
    assert.equal(broken.status, 1);
    assert.ok(Number(broken.outputs.errors) >= 1);
    assert.match(broken.stdout, /::error file=ext\/_locales\/de\/messages\.json,line=\d+,title=ext-localize::de > sessionSaved/);

    // 5. a new run while the PR is open -> the PR is updated, not duplicated
    git(repo.work, ["checkout", "-q", "-f", "main"]);
    writeFileSync(enPath, JSON.stringify(en, null, 2) + "\n");
    const again = await runAction({ workspace: repo.work, inputs: translateInputs, env: { ...env, FAKE_GH_LIST: '[{"number":7,"url":"https://github.com/owner/repo/pull/7"}]' } });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    gh = readGhLog(ghLog);
    assert.equal(gh.filter((c) => c.args[1] === "create").length, 1);
    assert.ok(gh.some((c) => c.args[1] === "edit" && c.args[2] === "7"));
    assert.match(again.summary, /PR updated/);
  });

  test("translate refuses pull_request events before calling any provider", async (t) => {
    const ws = tempDir(t);
    copyFixture(join(ws, "ext"));
    const server = await startFakeOpenAI(t);
    const r = await runAction({
      workspace: ws,
      inputs: { mode: "translate", path: "ext", provider: "openai", model: "m", to: "de" },
      env: { OPENAI_BASE_URL: server.url, GITHUB_EVENT_NAME: "pull_request", DEFAULT_BRANCH: "main" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /::error title=ext-localize::Input error: mode: translate does not run on "pull_request"/);
    assert.equal(server.requests.length, 0);
  });

  test("translate refuses to run from a branch other than the PR base", async (t) => {
    const ws = tempDir(t);
    copyFixture(join(ws, "ext"));
    const server = await startFakeOpenAI(t);
    const r = await runAction({
      workspace: ws,
      inputs: { mode: "translate", path: "ext", provider: "openai", model: "m", to: "de" },
      env: { OPENAI_BASE_URL: server.url, GITHUB_EVENT_NAME: "workflow_dispatch", DEFAULT_BRANCH: "main", GITHUB_REF_NAME: "feat" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /runs on "feat", but the PR base is "main"/);
    assert.equal(server.requests.length, 0);
  });

  test("a key with a line break cannot inject a workflow command into the log", async (t) => {
    const ws = tempDir(t);
    copyFixture(join(ws, "ext"));
    const enPath = join(ws, "ext", "_locales", "en", "messages.json");
    const en = readJson(enPath);
    en["bad\n::warning::injected"] = { message: "x" };
    writeFileSync(enPath, JSON.stringify(en, null, 2));
    const r = await runAction({ workspace: ws, inputs: { mode: "check", path: "ext" } });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /^::warning::injected/m);
    assert.match(r.stdout, /::error file=ext\/_locales\/en\/messages\.json,(line=\d+,)?title=ext-localize::en > bad%0A::warning::injected: /);
  });

  test("translate with no target locales: nothing to do, no PR, job passes (CLI exit 3)", async (t) => {
    const repo = makeRepo(t);
    const bin = join(repo.base, "bin");
    const ghLog = join(repo.base, "gh.log");
    fakeGh(bin, ghLog);
    const r = await runAction({
      workspace: repo.work,
      inputs: { mode: "translate", path: "ext", provider: "openai", model: "m" },
      env: { PATH: `${bin}:${process.env.PATH}`, OPENAI_BASE_URL: "http://127.0.0.1:9/v1", GITHUB_EVENT_NAME: "push", DEFAULT_BRANCH: "main", GITHUB_REF_NAME: "main" },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.result, "no-targets");
    assert.equal(r.outputs.changed, "false");
    assert.match(r.summary, /no target locales, nothing to do/);
    assert.match(r.summary, /Set the `to` input/);
    assert.equal(readGhLog(ghLog).filter((c) => c.args[0] === "pr").length, 0);
  });

  test("translate with a CLI error result (missing key): no PR, job fails, the error is shown", async (t) => {
    const repo = makeRepo(t);
    const bin = join(repo.base, "bin");
    const ghLog = join(repo.base, "gh.log");
    fakeGh(bin, ghLog);
    // openai with no key and no OPENAI_BASE_URL fails before any network call.
    const r = await runAction({
      workspace: repo.work,
      inputs: { mode: "translate", path: "ext", provider: "openai", model: "m", to: "de" },
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_EVENT_NAME: "push", DEFAULT_BRANCH: "main", GITHUB_REF_NAME: "main" },
    });
    assert.equal(r.status, 1);
    assert.equal(r.outputs.result, "error");
    assert.match(r.summary, /translate failed\. Nothing was committed/);
    assert.match(r.summary, /OPENAI\\_API\\_KEY is not set/);
    assert.equal(readGhLog(ghLog).filter((c) => c.args[0] === "pr").length, 0);
  });

  test("GitHub blocks PR creation: branch is pushed, job fails with the setting to turn on", async (t) => {
    const repo = makeRepo(t);
    const server = await startFakeOpenAI(t);
    const bin = join(repo.base, "bin");
    const ghLog = join(repo.base, "gh.log");
    fakeGh(bin, ghLog);
    const r = await runAction({
      workspace: repo.work,
      inputs: { mode: "translate", path: "ext", provider: "openai", model: "m", to: "de" },
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        OPENAI_BASE_URL: server.url,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        DEFAULT_BRANCH: "main",
        GITHUB_REF_NAME: "main",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "owner/repo",
        FAKE_GH_CREATE_ERROR: "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)",
      },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.outputs.result, "pr-blocked");
    assert.equal(r.outputs.changed, "true");
    assert.equal(r.outputs["pr-url"], "");
    // The strings are safe on the bot branch.
    const files = git(repo.remote, ["show", "--name-only", "--format=", "refs/heads/ext-localize/translations"]).trim().split("\n").sort();
    assert.deepEqual(files, ["ext/.localizer/state.json", "ext/_locales/de/messages.json"]);
    // One clear error annotation: names the branch and the setting.
    const err = r.stdout.split("\n").find((l) => l.startsWith("::error title=ext-localize%3A pull request not allowed::"));
    assert.ok(err, r.stdout);
    assert.match(err, /branch "ext-localize\/translations"/);
    assert.match(err, /Settings > Actions > General > Workflow permissions > "Allow GitHub Actions to create and approve pull requests"/);
    assert.match(err, /organization/);
    assert.match(err, /https:\/\/github\.com\/owner\/repo\/compare\/main\.\.\.ext-localize\/translations\?expand=1/);
    assert.match(r.summary, /branch pushed, but GitHub blocked the pull request/);
    assert.match(r.summary, /Allow GitHub Actions to create and approve pull requests/);
    assert.match(r.summary, /\| de \| 25 \|/, "the translation table is still in the summary");
  });

  test("listing: true translates messages, then the store listing, in one PR", async (t) => {
    const repo = makeRepo(t);
    const server = await startFakeOpenAI(t);
    const bin = join(repo.base, "bin");
    const ghLog = join(repo.base, "gh.log");
    fakeGh(bin, ghLog);
    const r = await runAction({
      workspace: repo.work,
      inputs: { mode: "translate", path: "ext", provider: "openai", model: "m", to: "de", listing: "true", store: "chrome" },
      env: { PATH: `${bin}:${process.env.PATH}`, OPENAI_BASE_URL: server.url, GITHUB_EVENT_NAME: "workflow_dispatch", DEFAULT_BRANCH: "main", GITHUB_REF_NAME: "main" },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.result, "pass");
    const files = git(repo.remote, ["show", "--name-only", "--format=", "refs/heads/ext-localize/translations"]).trim().split("\n").sort();
    assert.deepEqual(files, ["ext/.localizer/state.json", "ext/_locales/de/messages.json", "ext/listing/de.json"]);
    const listing = JSON.parse(git(repo.remote, ["show", "refs/heads/ext-localize/translations:ext/listing/de.json"]));
    assert.match(listing.description, /^\[de\] /);
    const create = readGhLog(ghLog).find((c) => c.args[1] === "create");
    const body = create.args[create.args.indexOf("--body") + 1];
    assert.match(body, /### Messages/);
    assert.match(body, /### Store listing/);
  });

  test("cli-source can also be a path to the CLI folder", async (t) => {
    const ws = tempDir(t);
    copyFixture(join(ws, "ext"));
    const r = await runAction({ workspace: ws, inputs: { mode: "check", path: "ext", "cli-source": CLI_DIR } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`Using CLI: ${CLI_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  test("bad inputs are reported as one clear error", async (t) => {
    const ws = tempDir(t);
    copyFixture(join(ws, "ext"));
    for (const [inputs, re] of [
      [{ mode: "sync" }, /mode must be "check" or "translate"/],
      [{ stale: "maybe" }, /stale must be one of fail, warn, ignore/],
      [{ path: "../outside" }, /outside the workspace/],
      [{ strict: "yes" }, /expected "true" or "false"/],
      [{ "cli-source": "./nope" }, /cli-source "\.\/nope" does not exist/],
    ]) {
      const r = await runAction({ workspace: ws, inputs: { path: "ext", ...inputs } });
      assert.equal(r.status, 1);
      assert.match(r.stdout, re);
    }
  });

  test("check reports a missing manifest as an error", async (t) => {
    const ws = tempDir(t);
    const r = await runAction({ workspace: ws, inputs: { mode: "check" } });
    // `check` reports a missing manifest as an error issue (exit 1 with JSON).
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no manifest\.json/);
  });
}
