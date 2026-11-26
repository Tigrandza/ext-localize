// The machine-readable contract the GitHub Action (action/) relies on:
// check --json (stale, file, line), translate --json, exit codes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkProject } from "../src/check.ts";
import { main } from "../src/cli.ts";
import { loadGlossary } from "../src/glossary.ts";
import { defaultListingTargets, listingJob, loadListing } from "../src/listing.ts";
import { loadProject } from "../src/messages.ts";
import { hashSource, loadState } from "../src/state.ts";
import { runJob, translateProject } from "../src/translate.ts";
import { MockProvider, copyFixture, makeExtension } from "./helpers.ts";

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

/** Fixture translated to de (messages and listing) with the mock provider. */
async function translatedFixture(): Promise<string> {
  const dir = copyFixture();
  const provider = new MockProvider();
  const project = loadProject(dir);
  await translateProject(project, loadState(dir, "en"), { provider, glossary: loadGlossary(dir), targets: ["de"] });
  const lp = loadListing(project, join(dir, "listing"));
  await runJob(listingJob(project, lp, ["chrome"]), loadState(dir, "en"), { provider, targets: ["de"] });
  return dir;
}

function editSource(dir: string, key: string, message: string) {
  const path = join(dir, "_locales/en/messages.json");
  const src = readJson(path);
  src[key].message = message;
  writeFileSync(path, JSON.stringify(src, null, 2));
}

// ---------------------------------------------------------------------------
// stale
// ---------------------------------------------------------------------------

test("stale: a source change after translation is reported with kind, file and line", async () => {
  const dir = await translatedFixture();
  assert.equal(checkProject(dir).stale, 0);
  editSource(dir, "actionTitle", "Open TabNest now");
  const r = checkProject(dir);
  assert.equal(r.stale, 1);
  const issue = r.issues.find((i) => i.kind === "stale")!;
  assert.equal(issue.level, "warning");
  assert.equal(issue.locale, "de");
  assert.equal(issue.key, "actionTitle");
  assert.equal(issue.file, "_locales/de/messages.json");
  const lines = readFileSync(join(dir, issue.file!), "utf8").split("\n");
  assert.match(lines[issue.line! - 1]!, /"actionTitle":/);
  assert.equal(r.staleCheck.status, "ok");
  assert.equal(r.staleCheck.mode, "warning");
});

test("stale: --stale=error makes it an error (exit 1); --stale=off hides it", async () => {
  const dir = await translatedFixture();
  editSource(dir, "actionTitle", "Open TabNest now");
  const warn = await capture(["check", "--dir", dir, "--json"]);
  assert.equal(warn.code, 0);
  assert.equal(JSON.parse(warn.stdout).stale, 1);
  const err = await capture(["check", "--dir", dir, "--json", "--stale=error"]);
  assert.equal(err.code, 1);
  const rep = JSON.parse(err.stdout);
  assert.equal(rep.errors, 1);
  assert.equal(rep.issues[0].kind, "stale");
  const off = await capture(["check", "--dir", dir, "--json", "--stale", "off"]);
  assert.equal(JSON.parse(off.stdout).stale, 0);
  assert.equal(JSON.parse(off.stdout).staleCheck.status, "off");
  assert.equal((await capture(["check", "--dir", dir, "--stale=maybe"])).code, 2);
});

test("stale: matches the 'changed' plan of translate --dry-run", async () => {
  const dir = await translatedFixture();
  editSource(dir, "actionTitle", "Open TabNest now");
  editSource(dir, "extShortName", "Nest");
  const stale = checkProject(dir).issues.filter((i) => i.kind === "stale" && !i.key!.startsWith("listing."));
  const dry = await capture(["translate", "--dir", dir, "--to", "de", "--dry-run", "--json"]);
  const de = JSON.parse(dry.stdout).locales[0];
  assert.equal(de.changed, stale.length);
});

test("stale: listing fields too", async () => {
  const dir = await translatedFixture();
  const path = join(dir, "listing/en.json");
  const src = readJson(path);
  src.description.push("One more line.");
  writeFileSync(path, JSON.stringify(src, null, 2));
  const issue = checkProject(dir).issues.find((i) => i.kind === "stale")!;
  assert.equal(issue.key, "listing.description");
  assert.equal(issue.file, "listing/de.json");
  assert.equal(issue.line, 4);
});

test("stale: listing name copied from _locales is not reported; its _locales message is", async () => {
  const dir = await translatedFixture();
  editSource(dir, "extName", "TabNest Plus");
  const stale = checkProject(dir).issues.filter((i) => i.kind === "stale").map((i) => i.key);
  assert.deepEqual(stale, ["extName"]);
  const dry = await capture(["translate", "--listing", "--dir", dir, "--to", "de", "--dry-run", "--json"]);
  assert.equal(JSON.parse(dry.stdout).locales[0].changed, 0);
});

test("translate --json: a real run (fake DeepL) with one failed key exits 1", async () => {
  const dir = copyFixture();
  const realFetch = globalThis.fetch;
  const realKey = process.env.DEEPL_API_KEY;
  process.env.DEEPL_API_KEY = "fake-key:fx";
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/v2/languages?type=target")) return new Response(JSON.stringify([{ language: "DE", supports_formality: true }]));
    const body = JSON.parse(String(init?.body)) as { text: string[] };
    // Drop the markers of one string, so its placeholders break and it fails.
    const translations = body.text.map((t) => ({ text: t.startsWith("Saved <x") ? "kaputt" : `DE ${t}` }));
    return new Response(JSON.stringify({ translations }));
  }) as typeof fetch;
  try {
    const r = await capture(["translate", "--dir", dir, "--provider", "deepl", "--to", "de", "--json"]);
    const out = JSON.parse(r.stdout);
    assert.equal(r.code, 1);
    assert.equal(out.exitCode, 1);
    assert.equal(out.dryRun, false);
    assert.equal(out.provider, "deepl");
    assert.equal(out.stopped, null);
    const de = out.locales[0];
    assert.ok(de.failed >= 1);
    assert.ok(de.failedKeys.every((f: { key: string; error: string }) => f.key && f.error));
    assert.equal(de.translated + de.failed, 25);
    assert.deepEqual(out.filesWritten, [".localizer/state.json", "_locales/de/messages.json"]);
    assert.deepEqual(de.written, ["_locales/de/messages.json"]);
    assert.equal(typeof out.check.errors, "number");
    assert.ok(out.check.errors >= 1, "the failed keys are missing in de");
    assert.ok(!r.stdout.includes("de: ") || r.stdout.trim().startsWith("{"), "progress goes to stderr");
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.DEEPL_API_KEY;
    else process.env.DEEPL_API_KEY = realKey;
  }
});

test("stale: no state file, an unknown version and untracked keys", () => {
  const dir = copyFixture();
  assert.equal(checkProject(dir).staleCheck.status, "no-state");
  writeFileSync(join(dir, ".localizer/state.json"), JSON.stringify({ version: 9, sourceLocale: "en", locales: {} }));
  const r = checkProject(dir, { stale: "error" });
  assert.equal(r.staleCheck.status, "unknown-version");
  const issue = r.issues.find((i) => i.kind === "state")!;
  assert.equal(issue.level, "error");
  assert.equal(issue.file, ".localizer/state.json");
  assert.equal(r.stale, 0);
});

test("stale: the hash recipe is unchanged (the Action copies it)", () => {
  // sha256(JSON.stringify({message, placeholders: [[lower-cased name, content], ...] sorted by name})); no description.
  const msg = { message: "Hi $Name$ $b$", description: "ignored", placeholders: { Name: { content: "$1" }, b: { content: "x" } } };
  const expected = createHash("sha256")
    .update(JSON.stringify({ message: msg.message, placeholders: [["b", "x"], ["name", "$1"]] }), "utf8")
    .digest("hex");
  assert.equal(hashSource(msg), expected);
});

// ---------------------------------------------------------------------------
// file and line
// ---------------------------------------------------------------------------

test("check --json: every issue has a file; line where it can be found", async () => {
  const dir = makeExtension({
    "manifest.json": '{\n  "manifest_version": 3,\n  "name": "__MSG_extName__",\n  "description": "__MSG_gone__",\n  "version": "1",\n  "default_locale": "en"\n}\n',
    "_locales/en/messages.json": { extName: { message: "X $count$" }, other: { message: "Y" } },
    "_locales/de/messages.json": { extName: { message: "X" } },
    "_locales/fr/messages.json": '{\n  "extName": {\n    "message": "X"\n  },\n  oops\n}\n',
  });
  const { stdout, code } = await capture(["check", "--dir", dir, "--json"]);
  assert.equal(code, 1);
  const rep = JSON.parse(stdout);
  for (const i of rep.issues) assert.equal(typeof i.file, "string", JSON.stringify(i));
  const find = (pred: (i: { file: string; key?: string; message: string }) => boolean) => rep.issues.find(pred);
  const gone = find((i) => i.message.includes("__MSG_gone__"));
  assert.equal(gone.file, "manifest.json");
  assert.equal(gone.line, 4);
  const undef = find((i) => i.message.includes("is used but not defined"));
  assert.equal(undef.file, "_locales/en/messages.json");
  assert.equal(undef.line, 2);
  const missing = find((i) => i.file === "_locales/de/messages.json" && i.key === "other");
  assert.equal(missing.line, undefined, "a missing key has no line");
  const bad = find((i) => i.file === "_locales/fr/messages.json");
  assert.equal(bad.line, 5);
});

// ---------------------------------------------------------------------------
// translate --json and exit codes
// ---------------------------------------------------------------------------

test("translate --json: dry run shape; stdout is only JSON", async () => {
  const dir = copyFixture();
  const r = await capture(["translate", "--dir", dir, "--to", "de,fr", "--dry-run", "--json"]);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.command, "translate");
  assert.equal(out.target, "messages");
  assert.equal(out.dryRun, true);
  assert.equal(out.ok, true);
  assert.equal(out.noTargets, false);
  assert.equal(out.stopped, null);
  assert.deepEqual(Object.keys(out.locales[0]), [
    "locale", "new", "changed", "invalid", "forced", "removed", "kept", "adopted", "manual",
    "translated", "failed", "requests", "skipped", "failedKeys", "written",
  ]);
  assert.equal(out.locales[0].new, 25);
  assert.deepEqual(out.filesWritten, []);
  assert.deepEqual(out.mayWrite, ["_locales/<locale>/messages.json", ".localizer/state.json"]);
  assert.equal(out.check, null);
});

test("translate --json --listing: mayWrite names the listing folder", async () => {
  const dir = copyFixture();
  const r = await capture(["translate", "--listing", "--dir", dir, "--to", "de", "--dry-run", "--json"]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.target, "listing");
  assert.deepEqual(out.mayWrite, ["listing/<locale>.json", ".localizer/state.json"]);
  assert.equal(out.locales[0].new, 3);
});

test("translate: no target locales exits 3, with noTargets in --json", async () => {
  const dir = copyFixture();
  const text = await capture(["translate", "--dir", dir, "--dry-run"]);
  assert.equal(text.code, 3);
  assert.match(text.stdout, /No target locales/);
  const json = await capture(["translate", "--dir", dir, "--dry-run", "--json"]);
  assert.equal(json.code, 3);
  const out = JSON.parse(json.stdout);
  assert.equal(out.noTargets, true);
  assert.equal(out.exitCode, 3);
});

test("--json: usage and config errors still print JSON (exit 2)", async () => {
  const dir = copyFixture();
  const bad = await capture(["translate", "--dir", dir, "--json", "--provider", "nope"]);
  assert.equal(bad.code, 2);
  assert.deepEqual(Object.keys(JSON.parse(bad.stdout)), ["command", "exitCode", "ok", "error"]);
  writeFileSync(join(dir, ".localizer/config.json"), '{"provder": "deepl"}');
  const cfg = await capture(["check", "--dir", dir, "--json"]);
  assert.equal(cfg.code, 2);
  assert.match(JSON.parse(cfg.stdout).error, /unknown setting "provder"/);
});

test("translate result lists written files; a second run writes nothing", async () => {
  const dir = copyFixture();
  const project = loadProject(dir);
  const provider = new MockProvider({ omitKeys: new Set(["actionTitle"]) });
  const r1 = await translateProject(project, loadState(dir, "en"), { provider, targets: ["de", "fr"] });
  assert.deepEqual(r1.filesWritten, [".localizer/state.json", "_locales/de/messages.json", "_locales/fr/messages.json"]);
  assert.deepEqual(r1.locales[0]!.failed.map((f) => f.key), ["actionTitle"]);
  const r2 = await translateProject(project, loadState(dir, "en"), { provider: new MockProvider(), targets: ["de", "fr"] });
  assert.deepEqual(r2.filesWritten.sort(), [".localizer/state.json", "_locales/de/messages.json", "_locales/fr/messages.json"], "the failed key is retried");
  const r3 = await translateProject(project, loadState(dir, "en"), { provider: new MockProvider(), targets: ["de", "fr"] });
  assert.deepEqual(r3.filesWritten, []);
  const lp = loadListing(project, join(dir, "listing"));
  const r4 = await runJob(listingJob(project, lp, ["chrome"]), loadState(dir, "en"), {
    provider: new MockProvider(),
    targets: defaultListingTargets(project, lp.dir),
  });
  assert.deepEqual(r4.filesWritten, [".localizer/state.json", "listing/de.json", "listing/fr.json"]);
});
