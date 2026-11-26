// Find and run the ext-localize CLI.
//
// cli-source = "npm"     -> npx --yes ext-localize@<cli-version>
// cli-source = "bundled" -> the cli/ folder next to this action/ folder, from
//                           the same commit as the Action (UNVERIFIED on GitHub:
//                           it needs the runner to download the whole repo).
// cli-source = <path>    -> a local checkout of cli/, or a .js/.ts entry file.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InputError } from "./gha.mjs";

/** cli/ next to action/ in this repository. */
export const BUNDLED_CLI = fileURLToPath(new URL("../../../cli", import.meta.url));

const VERSION_RE = /^[0-9A-Za-z.+-]+$/;

/** True when this Node can run .ts files directly (Node 22.18+ / 23.6+). */
export function canStripTypes(features = process.features) {
  return Boolean(features?.typescript);
}

/**
 * @returns {{command: string, prefix: string[], label: string, installDir?: string}}
 * installDir: a local CLI folder that has a package.json but no node_modules yet.
 */
export function resolveCli({ source, version, workspace, features = process.features }) {
  const src = (source ?? "").trim() || "npm";
  if (src === "npm") {
    const v = (version ?? "").trim() || "latest";
    if (!VERSION_RE.test(v)) throw new InputError(`cli-version "${version}" is not a valid version or tag`);
    return { command: "npx", prefix: ["--yes", `ext-localize@${v}`], label: `ext-localize@${v} (npm)` };
  }
  const abs = src === "bundled" ? BUNDLED_CLI : isAbsolute(src) ? src : resolve(workspace, src);
  if (!existsSync(abs)) {
    throw new InputError(
      src === "bundled"
        ? `cli-source "bundled": no cli/ folder next to the Action (looked at ${abs}). Use cli-source: npm or a path.`
        : `cli-source "${src}" does not exist (looked at ${abs})`,
    );
  }
  if (statSync(abs).isFile()) {
    if (abs.endsWith(".ts") && !canStripTypes(features)) {
      throw new InputError(`cli-source "${src}" is a .ts file, but Node ${process.version} cannot run TypeScript. Use node-version 22.18 or newer.`);
    }
    return { command: process.execPath, prefix: [abs], label: abs };
  }
  // A folder: prefer the TypeScript source (always current), else the built dist/.
  const ts = join(abs, "src", "cli.ts");
  const js = join(abs, "dist", "cli.js");
  const needsInstall = existsSync(join(abs, "package.json")) && !existsSync(join(abs, "node_modules"));
  const installDir = needsInstall ? abs : undefined;
  if (existsSync(ts) && canStripTypes(features)) return { command: process.execPath, prefix: [ts], label: ts, installDir };
  if (existsSync(js)) return { command: process.execPath, prefix: [js], label: js, installDir };
  throw new InputError(
    `cli-source "${src}" has no src/cli.ts this Node can run and no dist/cli.js. Use node-version 22.18 or newer, or build the CLI.`,
  );
}

/** Install the runtime dependencies of a local CLI folder (npm ci, no dev deps, no scripts). */
export function installLocalCli(dir, run = spawnSync) {
  const args = existsSync(join(dir, "package-lock.json"))
    ? ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]
    : ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
  const r = run("npm", args, { cwd: dir, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`npm ${args[0]} failed in ${dir}`);
}

/**
 * Run the CLI. Output is captured (and returned); the caller decides what to print.
 * The environment is passed through unchanged, so provider keys reach the CLI.
 * We never print the environment.
 */
export function runCli(cli, args, { cwd, env = process.env, run = spawnSync } = {}) {
  const r = run(cli.command, [...cli.prefix, ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`could not start ${cli.label}: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
