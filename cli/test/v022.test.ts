// Open items from the PageCarry field report, after 0.2.1:
// M1 (--locales-dir), B1 and C1 (check.ignoreKeys), B1 ("missing key" as a warning).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkLocale, checkProject, keyMatcher } from "../src/check.ts";
import { main } from "../src/cli.ts";
import { parseConfig } from "../src/config.ts";
import { loadProject } from "../src/messages.ts";
import { clearLocalesDir, setLocalesDir } from "../src/paths.ts";
import { loadState } from "../src/state.ts";
import { translateProject } from "../src/translate.ts";
import { MockProvider, makeExtension } from "./helpers.ts";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const log = console.log;
  const err = console.error;
  let stdout = "";
  let stderr = "";
  console.log = (...a: unknown[]) => void (stdout += a.join(" ") + "\n");
  console.error = (...a: unknown[]) => void (stderr += a.join(" ") + "\n");
  try {
    return { code: await main(argv), stdout, stderr };
  } finally {
    console.log = log;
    console.error = err;
  }
}

// ---------------------------------------------------------------------------
// M1: --locales-dir (WXT / Plasmo: manifest only in the build, _locales in public/)
// ---------------------------------------------------------------------------

/** A WXT-like repo: the build has the manifest, public/_locales has the real files. */
function wxtRepo() {
  const repo = makeExtension({
    ".output/chrome-mv3/manifest.json": { manifest_version: 3, name: "__MSG_appName__", version: "1", default_locale: "en" },
    "public/_locales/en/messages.json": { appName: { message: "PageCarry" }, hello: { message: "Hello" }, bye: { message: "Bye" } },
    // de lacks "bye": an error that only exists in public/_locales.
    "public/_locales/de/messages.json": { appName: { message: "PageCarry" }, hello: { message: "Hallo" } },
  });
  return { repo, build: join(repo, ".output/chrome-mv3"), locales: join(repo, "public/_locales") };
}

test("M1: check --locales-dir reads _locales from another folder and reports its real path", async () => {
  const { build, locales } = wxtRepo();
  // Without the flag the build has no _locales, so default_locale has no file.
  const plain = JSON.parse((await capture(["check", "--dir", build, "--json"])).stdout);
  assert.match(plain.issues[0].message, /has no _locales\/en\/messages\.json/);

  const r = await capture(["check", "--dir", build, "--locales-dir", locales, "--json"]);
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.locales, ["de", "en"]);
  const missing = report.issues.find((i: { key?: string }) => i.key === "bye");
  assert.equal(missing.level, "error");
  assert.equal(missing.file, "../../public/_locales/de/messages.json");
});

test("M1: translate writes into --locales-dir, never into the build folder", async () => {
  const { build, locales } = wxtRepo();
  setLocalesDir(build, locales);
  try {
    const project = loadProject(build);
    const provider = new MockProvider();
    const result = await translateProject(project, loadState(build, "en"), { provider, targets: ["de", "fr"] });
    assert.deepEqual(result.filesWritten, ["../../public/_locales/de/messages.json", "../../public/_locales/fr/messages.json", ".localizer/state.json"]);
    assert.equal(readJson(join(locales, "fr/messages.json")).hello.message, "[fr] Hello");
    assert.equal(readJson(join(locales, "de/messages.json")).bye.message, "[de] Bye");
    assert.equal(readJson(join(locales, "de/messages.json")).hello.message, "Hallo", "unchanged key kept");
    assert.equal(existsSync(join(build, "_locales")), false);
  } finally {
    clearLocalesDir(build);
  }
  // The next check through the CLI sees the new files and passes.
  const r = await capture(["check", "--dir", build, "--locales-dir", locales]);
  assert.equal(r.code, 0, r.stdout);
});

test("M1: translate --dry-run --json lists the real _locales path in mayWrite", async () => {
  const { build, locales } = wxtRepo();
  const r = JSON.parse((await capture(["translate", "--dir", build, "--locales-dir", locales, "--to", "de", "--dry-run", "--json"])).stdout);
  assert.equal(r.mayWrite[0], "../../public/_locales/<locale>/messages.json");
  assert.equal(r.locales[0].new, 1);
});

test("M1: config locales.dir is resolved from the config base; a missing folder is exit 2", async () => {
  const { repo, build } = wxtRepo();
  mkdirSync(join(repo, ".localizer"));
  const cfg = join(repo, ".localizer/config.json");
  writeFileSync(cfg, JSON.stringify({ locales: { dir: "public/_locales" } }));
  const r = JSON.parse((await capture(["check", "--dir", build, "--config", cfg, "--json"])).stdout);
  assert.deepEqual(r.locales, ["de", "en"]);

  writeFileSync(cfg, JSON.stringify({ locales: { dir: "src/_locales" } }));
  const bad = await capture(["check", "--dir", build, "--config", cfg]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /_locales folder not found: .*src\/_locales \(from locales\.dir "src\/_locales"/);

  const flag = await capture(["check", "--dir", build, "--locales-dir", join(repo, "nope")]);
  assert.equal(flag.code, 2);
  assert.match(flag.stderr, /from --locales-dir/);
});

test("M1: a --locales-dir from one run does not leak into the next run", async () => {
  const { build, locales } = wxtRepo();
  assert.equal((await capture(["check", "--dir", build, "--locales-dir", locales, "--json"])).code, 1);
  const again = JSON.parse((await capture(["check", "--dir", build, "--json"])).stdout);
  assert.deepEqual(again.locales, []);
});

test("M1: check --listing-only drops _locales issues from --locales-dir too", async () => {
  const { build, locales } = wxtRepo();
  const r = await capture(["check", "--dir", build, "--locales-dir", locales, "--listing-only", "--json"]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).errors, 0);
});

// ---------------------------------------------------------------------------
// B1 / C1: check.ignoreKeys
// ---------------------------------------------------------------------------

test("ignoreKeys: '*' is the only wildcard, matching is case-insensitive", () => {
  const m = keyMatcher(["appShortName", "*_zero", "ui_size_*", " "]);
  assert.equal(m("appShortName"), true);
  assert.equal(m("APPSHORTNAME"), true);
  assert.equal(m("files_zero"), true);
  assert.equal(m("ui_size_a4"), true);
  assert.equal(m("appShortNameX"), false);
  assert.equal(m("files.zero"), false);
  assert.equal(keyMatcher(["a.b"])("axb"), false, "a dot is literal");
});

function rtlExtension(config?: unknown) {
  return makeExtension({
    "manifest.json": { manifest_version: 3, name: "X", version: "1", default_locale: "en" },
    "_locales/en/messages.json": {
      appShortName: { message: "PageCarry Pro" },
      ui_size_letter: { message: "US Letter" },
      title: { message: "Save page" },
    },
    "_locales/ar/messages.json": {
      appShortName: { message: "PageCarry Pro" },
      ui_size_letter: { message: "US Letter size" },
      title: { message: "Save page now" },
    },
    ...(config ? { ".localizer/config.json": config } : {}),
  });
}

test("ignoreKeys: drops RTL warnings for listed keys and keeps the rest", async () => {
  const before = checkProject(rtlExtension());
  assert.deepEqual(before.issues.map((i) => i.key).sort(), ["title", "ui_size_letter"]);

  const after = checkProject(rtlExtension(), { ignoreKeys: ["ui_size_*"] });
  assert.deepEqual(after.issues.map((i) => i.key), ["title"]);
  assert.equal(after.warnings, 1);

  // Through the CLI, from the config file.
  const dir = rtlExtension({ check: { ignoreKeys: ["ui_size_*", "TITLE"] } });
  const r = await capture(["check", "--dir", dir, "--strict"]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /0 error\(s\), 0 warning\(s\)/);
});

test("ignoreKeys: also drops errors for the key (a whole plural family the tool should not judge)", () => {
  const dir = makeExtension({
    "manifest.json": { manifest_version: 3, name: "X", version: "1", default_locale: "en" },
    "_locales/en/messages.json": { n_zero: { message: "none" }, title: { message: "T" } },
    "_locales/de/messages.json": { title: { message: "T" }, legacy_key: { message: "alt" } },
  });
  const r = checkProject(dir);
  assert.deepEqual(r.issues.map((i) => `${i.level} ${i.key}`).sort(), ["error legacy_key", "error n_zero"]);
  const ignored = checkProject(dir, { ignoreKeys: ["*_zero", "legacy_*"] });
  assert.equal(ignored.issues.length, 0);
  assert.equal(ignored.errors, 0);
});

// ---------------------------------------------------------------------------
// B1: missing keys in a non-default locale as warnings (Chrome falls back)
// ---------------------------------------------------------------------------

test("missingKeys: 'warning' turns only 'missing (present in source)' into a warning", () => {
  const src = { a: { message: "A $1" }, b: { message: "B" } };
  const tgt = { a: { message: "A" }, extra: { message: "x" } };
  const def = checkLocale(src, tgt, "de");
  const relaxed = checkLocale(src, tgt, "de", { missingKeys: "warning" });
  const pick = (issues: typeof def, key: string) => issues.filter((i) => i.key === key).map((i) => i.level);
  assert.deepEqual(pick(def, "b"), ["error"]);
  assert.deepEqual(pick(relaxed, "b"), ["warning"]);
  assert.deepEqual(pick(relaxed, "extra"), ["error"], "extra keys stay errors");
  assert.deepEqual(pick(relaxed, "a"), pick(def, "a"), "placeholder problems unchanged");
});

test("missingKeys: from config through the CLI; --strict still fails on it", async () => {
  const files = {
    "manifest.json": { manifest_version: 3, name: "X", version: "1", default_locale: "en" },
    "_locales/en/messages.json": { a: { message: "A" }, b: { message: "B" } },
    "_locales/de/messages.json": { a: { message: "A de" } },
  };
  const strictDir = makeExtension(files);
  assert.equal((await capture(["check", "--dir", strictDir])).code, 1);

  const dir = makeExtension({ ...files, ".localizer/config.json": { check: { missingKeys: "warning" } } });
  const r = await capture(["check", "--dir", dir]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /warn {3}de > b: missing \(present in source\)/);
  assert.equal((await capture(["check", "--dir", dir, "--strict"])).code, 1);
});

test("config: check and locales settings are validated", () => {
  assert.deepEqual(parseConfig({ check: { ignoreKeys: ["a"], missingKeys: "warning" }, locales: { dir: "x" } }), {
    check: { ignoreKeys: ["a"], missingKeys: "warning" },
    locales: { dir: "x" },
  });
  assert.throws(() => parseConfig({ check: { missingKeys: "off" } }), /"check.missingKeys" must be "error" or "warning"/);
  assert.throws(() => parseConfig({ check: { ignoreKeys: "a" } }), /"check.ignoreKeys" must be an array of strings/);
  assert.throws(() => parseConfig({ check: { ignore: [] } }), /unknown setting "check.ignore"/);
  assert.throws(() => parseConfig({ locales: { dir: 1 } }), /"locales.dir" must be a string/);
});

// ---------------------------------------------------------------------------
// M1: --manifest (run before the first WXT build)
// ---------------------------------------------------------------------------

/** No build folder at all: a manifest kept in the repo, and public/_locales. */
function unbuiltRepo() {
  const repo = makeExtension({
    "extension/manifest.json": { manifest_version: 3, name: "__MSG_appName__", version: "1", default_locale: "en" },
    "public/_locales/en/messages.json": { appName: { message: "PageCarry" }, hello: { message: "Hello" } },
    "public/_locales/de/messages.json": { appName: { message: "PageCarry" }, hello: { message: "Hallo" } },
    ".localizer/config.json": { manifest: "extension/manifest.json", locales: { dir: "public/_locales" } },
  });
  return { repo, build: join(repo, ".output/chrome-mv3"), cfg: join(repo, ".localizer/config.json") };
}

test("M1: --manifest and --locales-dir work when the build folder does not exist yet", async () => {
  const { repo, build } = unbuiltRepo();
  const r = await capture([
    "check", "--dir", build, "--config", join(repo, ".localizer/config.json"),
    "--manifest", join(repo, "extension/manifest.json"), "--locales-dir", join(repo, "public/_locales"), "--json",
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).locales, ["de", "en"]);
  assert.equal(existsSync(build), false, "check writes nothing into --dir");
});

test("M1: config manifest is resolved from the config base and used by translate", async () => {
  const { repo, build, cfg } = unbuiltRepo();
  const dry = JSON.parse((await capture(["translate", "--dir", build, "--config", cfg, "--to", "fr", "--dry-run", "--json"])).stdout);
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.locales[0].locale, "fr");
  assert.equal(dry.locales[0].new, 2);
  assert.equal(dry.mayWrite[0], "../../public/_locales/<locale>/messages.json");
  assert.equal(existsSync(join(repo, ".output")), false);
});

test("M1: a manifest problem names the --manifest file, with its line", async () => {
  const { repo, build, cfg } = unbuiltRepo();
  writeFileSync(
    join(repo, "extension/manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "__MSG_appName__", description: "__MSG_appDesc__", version: "1", default_locale: "en" }, null, 2),
  );
  const r = JSON.parse((await capture(["check", "--dir", build, "--config", cfg, "--json"])).stdout);
  const issue = r.issues.find((i: { key?: string }) => i.key === "appDesc");
  assert.equal(issue.file, "../../extension/manifest.json");
  assert.equal(issue.line, 4);
  assert.match(issue.message, /^\.\.\/\.\.\/extension\/manifest\.json uses __MSG_appDesc__/);
});

test("M1: a missing --manifest or config manifest is exit 2; the setting does not leak", async () => {
  const { repo, build, cfg } = unbuiltRepo();
  const flag = await capture(["check", "--dir", build, "--config", cfg, "--manifest", join(repo, "nope.json")]);
  assert.equal(flag.code, 2);
  assert.match(flag.stderr, /manifest not found: .*nope\.json \(from --manifest\)/);

  writeFileSync(cfg, JSON.stringify({ manifest: "src/manifest.json" }));
  const conf = await capture(["check", "--dir", build, "--config", cfg]);
  assert.equal(conf.code, 2);
  assert.match(conf.stderr, /from manifest "src\/manifest\.json"/);

  // A plain run on another folder still reads its own manifest.json.
  const plain = makeExtension({
    "manifest.json": { manifest_version: 3, name: "X", version: "1", default_locale: "en" },
    "_locales/en/messages.json": { a: { message: "A" } },
  });
  assert.equal((await capture(["check", "--dir", plain])).code, 0);
  const none = JSON.parse((await capture(["check", "--dir", build, "--json"])).stdout);
  assert.match(none.issues[0].message, /^no manifest\.json in /);
});

// Live Ollama run on 10 real extensions (2026-11-27): 7 of 60 store names and summaries came back
// over the 75 / 132 limits, because the model was never told the limit.
test("translate tells the model the store limit for manifest name, short_name and description", async () => {
  const dir = makeExtension({
    "manifest.json": { manifest_version: 3, name: "__MSG_appName__", short_name: "__MSG_appShort__", description: "__MSG_appDesc__", version: "1", default_locale: "en" },
    "_locales/en/messages.json": {
      appName: { message: "Tab Saver", description: "Product name." },
      appShort: { message: "Tab Saver!" },
      appDesc: { message: "Save your tabs." },
      other: { message: "Hello" },
    },
  });
  const project = loadProject(dir);
  const provider = new MockProvider();
  await translateProject(project, loadState(dir), { targets: ["de"], provider });
  const items = new Map(provider.calls.flatMap((c) => c.items).map((i) => [i.key, i.description ?? ""]));
  assert.equal(items.get("appName"), "Product name. Maximum length: 75 characters.");
  assert.equal(items.get("appShort"), "Maximum length: 12 characters.");
  assert.equal(items.get("appDesc"), "Maximum length: 132 characters.");
  assert.equal(items.get("other"), "");
  // Only a hint: a longer answer is still written, and "check" warns about it.
  const de = readJson(join(dir, "_locales/de/messages.json"));
  assert.equal(de.appShort.message, "[de] Tab Saver!"); // 15 > 12
});
