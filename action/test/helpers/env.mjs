// Test helpers: temp folders, a copy of the sample extension, a fake
// OpenAI-compatible server, a fake `gh`, and a throwaway git repo.
// Nothing here talks to the network beyond 127.0.0.1.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ACTION_DIR = join(here, "..", "..");
export const CLI_DIR = join(ACTION_DIR, "..", "cli");
export const FIXTURE = join(CLI_DIR, "fixtures", "sample-extension");
export const MAIN = join(ACTION_DIR, "scripts", "main.mjs");

export function tempDir(t, prefix = "ext-localize-action-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Copy the CLI's sample extension into `dest` (never run translate on the original). */
export function copyFixture(dest) {
  cpSync(FIXTURE, dest, { recursive: true });
  return dest;
}

/**
 * Fake OpenAI Chat Completions server. Each string comes back as "[<locale>] <text>",
 * with all markers unchanged. Records every request.
 */
export async function startFakeOpenAI(t) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      const user = body.messages.find((m) => m.role === "user").content;
      const locale = user.match(/^Target language: .*\(([^)]+)\)$/m)[1];
      const json = user.split("Strings to translate (JSON):\n")[1].split("\n\nReturn {")[0];
      const items = JSON.parse(json);
      const translations = items.map((i) => ({ key: i.key, text: `[${locale}] ${i.text}` }));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ translations }) } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

/**
 * A fake `gh` on PATH. It logs its arguments (one JSON line per call) and answers:
 *   pr list   -> the content of $FAKE_GH_LIST (default "[]")
 *   pr create -> a PR URL, or $FAKE_GH_CREATE_ERROR on stderr with exit 1
 *   pr edit   -> nothing
 *   repo view -> "main"
 */
export function fakeGh(binDir, logFile) {
  mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, token: process.env.GH_TOKEN ? "set" : "unset" }) + "\\n");
if (args[0] === "pr" && args[1] === "list") process.stdout.write(process.env.FAKE_GH_LIST || "[]");
else if (args[0] === "pr" && args[1] === "create" && process.env.FAKE_GH_CREATE_ERROR) { process.stderr.write(process.env.FAKE_GH_CREATE_ERROR + "\\n"); process.exitCode = 1; }
else if (args[0] === "pr" && args[1] === "create") process.stdout.write("https://github.com/owner/repo/pull/7\\n");
else if (args[0] === "repo" && args[1] === "view") process.stdout.write("main\\n");
`;
  const path = join(binDir, "gh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  // The script uses require(): mark the folder as CommonJS in case a parent package.json says "module".
  writeFileSync(join(binDir, "package.json"), JSON.stringify({ type: "commonjs" }));
  return path;
}

export function readGhLog(logFile) {
  try {
    return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Git env that ignores the user's global and system config (no signing, no hooks). */
export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

export function git(cwd, args, env = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * A throwaway repo in a temp folder: `work` (checked out on main, with the
 * sample extension in `ext/`) and a bare `remote.git` as origin.
 */
export function makeRepo(t) {
  const base = tempDir(t);
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  git(base, ["init", "--bare", "-b", "main", remote]);
  git(base, ["init", "-b", "main", work]);
  copyFixture(join(work, "ext"));
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "init"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "origin", "main"]);
  return { base, remote, work, ext: join(work, "ext") };
}

/**
 * Run the Action entry point like the runner would. Async on purpose: the fake
 * provider server runs in this process, so a blocking spawnSync would deadlock.
 */
export async function runAction({ workspace, inputs, env = {} }) {
  const out = join(workspace, "..", `out-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(out, { recursive: true });
  const outputFile = join(out, "output.txt");
  const summaryFile = join(out, "summary.md");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");
  const inputEnv = {};
  for (const [k, v] of Object.entries(inputs)) inputEnv[`INPUT_${k.toUpperCase().replace(/-/g, "_")}`] = v;
  const baseEnv = { ...process.env };
  for (const k of Object.keys(baseEnv)) {
    // Never let a real provider key from the developer's shell reach the CLI in tests.
    if (k.startsWith("INPUT_") || /_API_KEY$/.test(k) || /^AMO_/.test(k) || k.startsWith("GITHUB_") || k === "OPENAI_BASE_URL" || k === "OLLAMA_HOST") delete baseEnv[k];
  }
  const child = spawn(process.execPath, [MAIN], {
    cwd: workspace,
    env: {
      ...baseEnv,
      ...GIT_ENV,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      INPUT_CLI_SOURCE: "bundled", // cli/ next to action/: the same path a real runner would use
      ...inputEnv,
      ...env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return {
    status,
    stdout,
    stderr,
    outputs: parseOutputs(readFileSync(outputFile, "utf8")),
    summary: readFileSync(summaryFile, "utf8"),
  };
}

export function parseOutputs(text) {
  const out = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([^<]+)<<(.+)$/);
    if (!m) continue;
    const value = [];
    i++;
    while (i < lines.length && lines[i] !== m[2]) value.push(lines[i++]);
    out[m[1]] = value.join("\n");
  }
  return out;
}
