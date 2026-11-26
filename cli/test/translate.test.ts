import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkProject } from "../src/check.ts";
import { loadGlossary } from "../src/glossary.ts";
import { loadProject } from "../src/messages.ts";
import { loadState } from "../src/state.ts";
import { ProviderError } from "../src/providers/types.ts";
import { HttpError } from "../src/retry.ts";
import { translateProject } from "../src/translate.ts";
import { MockProvider, copyFixture } from "./helpers.ts";

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function run(dir: string, provider: MockProvider | undefined, extra: Record<string, unknown> = {}) {
  const project = loadProject(dir);
  const state = loadState(dir, project.defaultLocale);
  return translateProject(project, state, { provider, glossary: loadGlossary(dir), ...extra });
}

test("full run writes valid locale files and state; second run sends 0 requests", async () => {
  const dir = copyFixture();
  const provider = new MockProvider({ maxItems: 10 });
  const r1 = await run(dir, provider, { targets: ["de", "fr"] });
  assert.equal(r1.failedCount, 0);
  assert.equal(r1.totalRequests, 6); // 25 keys / 10 per batch = 3 per locale
  const de = readJson(join(dir, "_locales/de/messages.json"));
  assert.equal(de.proPrice.message, "[de] Upgrade to Pro for $$4.99 per month");
  assert.equal(de.sessionSaved.message, '[de] Saved $count$ tabs to "$session_name$".');
  assert.deepEqual(de.sessionSaved.placeholders, { count: { content: "$1", example: "12" }, session_name: { content: "$2", example: "Research" } });
  assert.equal(checkProject(dir).errors, 0);

  const state = readJson(join(dir, ".localizer/state.json"));
  assert.equal(state.version, 1);
  assert.equal(state.sourceLocale, "en");
  assert.deepEqual(Object.keys(state.locales), ["de", "fr"]);
  assert.equal(state.locales.de.messages.extName.by, "mock/test");

  const again = new MockProvider();
  const r2 = await run(dir, again, { targets: ["de", "fr"] });
  assert.equal(r2.totalRequests, 0);
  assert.equal(again.calls.length, 0);
});

test("only new or changed keys are re-translated; deleted keys are removed", async () => {
  const dir = copyFixture();
  await run(dir, new MockProvider(), { targets: ["de"] });
  const srcPath = join(dir, "_locales/en/messages.json");
  const src = readJson(srcPath);
  src.buttonRestore.message = "Restore all";
  src.brandNew = { message: "Brand new string" };
  delete src.buttonDelete;
  writeFileSync(srcPath, JSON.stringify(src, null, 2));

  const provider = new MockProvider();
  await run(dir, provider, { targets: ["de"] });
  const sent = provider.calls.flatMap((c) => c.items.map((i) => i.key)).sort();
  assert.deepEqual(sent, ["brandNew", "buttonRestore"]);
  const de = readJson(join(dir, "_locales/de/messages.json"));
  assert.equal(de.buttonRestore.message, "[de] Restore all");
  assert.equal(de.buttonDelete, undefined);
  const state = readJson(join(dir, ".localizer/state.json"));
  assert.equal(state.locales.de.messages.buttonDelete, undefined);
  assert.equal(checkProject(dir).errors, 0);
});

test("a locale added after the first run gets all keys; old locales are untouched", async () => {
  const dir = copyFixture();
  await run(dir, new MockProvider(), { targets: ["de"] });
  const provider = new MockProvider();
  await run(dir, provider, { targets: ["de", "ja"] });
  assert.ok(provider.calls.every((c) => c.targetLocale === "ja"));
  assert.equal(provider.calls.flatMap((c) => c.items).length, 25);
});

test("a failed locale does not block others, and the next run resumes it", async () => {
  const dir = copyFixture();
  const failing = new MockProvider({ failLocales: new Set(["ja"]) });
  const r1 = await run(dir, failing, { targets: ["de", "ja"], concurrency: 1 });
  assert.equal(r1.failedCount, 25);
  // A batch that fails on the transport level is not re-sent key by key.
  assert.equal(failing.calls.filter((c) => c.targetLocale === "ja").length, 3);
  assert.ok(existsSync(join(dir, "_locales/de/messages.json")));
  assert.ok(!existsSync(join(dir, "_locales/ja/messages.json")));
  const provider = new MockProvider();
  await run(dir, provider, { targets: ["de", "ja"] });
  assert.ok(provider.calls.every((c) => c.targetLocale === "ja"));
  assert.equal(checkProject(dir).errors, 0);
});

test("broken markers are retried one by one; if still broken the key is not written", async () => {
  const dir = copyFixture();
  const provider = new MockProvider({ breakKeys: new Set(["sessionSaved"]), breakOnceKeys: new Set(["memoryFreed"]) });
  const r = await run(dir, provider, { targets: ["de"] });
  assert.deepEqual(r.locales[0]!.failed.map((f) => f.key), ["sessionSaved"]);
  assert.match(r.locales[0]!.failed[0]!.error, /missing/);
  const de = readJson(join(dir, "_locales/de/messages.json"));
  assert.equal(de.sessionSaved, undefined);
  assert.equal(de.memoryFreed.message, "[de] You freed about $MEGABYTES$ MB of memory today.");
  const state = readJson(join(dir, ".localizer/state.json"));
  assert.equal(state.locales.de.messages.sessionSaved, undefined);
});

test("keys missing from the response are retried", async () => {
  const dir = copyFixture();
  const provider = new MockProvider({ omitKeys: new Set(["tabsCount"]) });
  const r = await run(dir, provider, { targets: ["de"] });
  assert.deepEqual(r.locales[0]!.failed.map((f) => f.key), ["tabsCount"]);
  assert.match(r.locales[0]!.failed[0]!.error, /no translation returned/);
});

test("a truncated response splits the batch", async () => {
  const dir = copyFixture();
  const provider = new MockProvider({ maxItems: 25, truncateAbove: 7 });
  const r = await run(dir, provider, { targets: ["de"] });
  assert.equal(r.failedCount, 0);
  assert.ok(provider.calls.length > 1);
  assert.ok(provider.calls.filter((c) => c.items.length <= 7).length >= 4);
});

test("glossary: keep terms reach the provider as markers, terms are passed per locale", async () => {
  const dir = copyFixture();
  const provider = new MockProvider();
  await run(dir, provider, { targets: ["de"] });
  const items = provider.calls.flatMap((c) => c.items);
  const name = items.find((i) => i.key === "extName")!;
  assert.equal(name.text, '<x id="0">TabNest</x> – Tab Manager & Session Saver');
  assert.deepEqual(provider.calls[0]!.terms, [["workspace", "Arbeitsbereich"]]);
  const saved = items.find((i) => i.key === "sessionSaved")!;
  assert.equal(saved.description, "Toast shown after saving. count is a number, session_name is the name the user gave.");
  assert.deepEqual(saved.markerHints, ['<x id="0"/> = placeholder $count$ (example: "12")', '<x id="1"/> = placeholder $session_name$ (example: "Research")']);
});

test("dry run writes nothing and counts requests", async () => {
  const dir = copyFixture();
  const r = await run(dir, undefined, { targets: ["de", "fr", "ja"], dryRun: true, limits: { maxItems: 10, maxChars: 100000 } });
  assert.equal(r.totalRequests, 9);
  assert.ok(!existsSync(join(dir, "_locales/de")));
  assert.ok(!existsSync(join(dir, ".localizer/state.json")));
});

test("first run on an extension with existing translations adopts them", async () => {
  const dir = copyFixture();
  await run(dir, new MockProvider(), { targets: ["de"] });
  // Simulate an older project: state file lost, translations present.
  writeFileSync(join(dir, ".localizer/state.json"), JSON.stringify({ version: 1, sourceLocale: "en", locales: {} }));
  const provider = new MockProvider();
  await run(dir, provider, { targets: ["de"] });
  assert.equal(provider.calls.length, 0);
  const state = readJson(join(dir, ".localizer/state.json"));
  assert.equal(state.locales.de.messages.extName.by, "adopted");
});

test("a locale file that does not parse is skipped, not overwritten", async () => {
  const dir = copyFixture();
  await run(dir, new MockProvider(), { targets: ["de"] });
  const path = join(dir, "_locales/de/messages.json");
  writeFileSync(path, "{ broken");
  const r = await run(dir, new MockProvider(), { targets: ["de"] });
  assert.match(r.locales[0]!.skipped ?? "", /invalid JSON/);
  assert.equal(readFileSync(path, "utf8"), "{ broken");
});

test("an auth error stops the whole run after one request", async () => {
  const dir = copyFixture();
  const provider = new MockProvider({ throwFor: () => new HttpError(401, "invalid key") });
  const r = await run(dir, provider, { targets: ["de", "fr", "ja"], concurrency: 1 });
  assert.equal(provider.calls.length, 1);
  assert.match(r.stopped ?? "", /invalid key/);
  assert.equal(r.failedCount, 25);
  assert.ok(r.locales.filter((l) => l.skipped?.startsWith("not started")).length === 2);
});

test("repeated transport failures stop the run", async () => {
  const dir = copyFixture();
  const provider = new MockProvider({ throwFor: () => new Error("socket hang up") });
  const r = await run(dir, provider, { targets: ["de", "fr", "ja"], concurrency: 1 });
  assert.equal(provider.calls.length, 3);
  assert.match(r.stopped ?? "", /3 requests failed in a row/);
});

test("an unusable answer (content error) is re-sent key by key", async () => {
  const dir = copyFixture();
  const provider = new MockProvider({ maxItems: 25, throwFor: (_req, i) => (i === 0 ? new ProviderError("bad JSON") : undefined) });
  const r = await run(dir, provider, { targets: ["de"] });
  assert.equal(r.failedCount, 0);
  assert.equal(provider.calls.length, 26);
});

test("if the provider's language list fails, the run stops", async () => {
  const dir = copyFixture();
  const provider = new MockProvider();
  (provider as unknown as { supportsLocale: () => Promise<boolean> }).supportsLocale = async () => {
    throw new HttpError(403, "Authentication failed");
  };
  const r = await run(dir, provider, { targets: ["de", "ja"] });
  assert.match(r.stopped ?? "", /Authentication failed/);
  assert.equal(provider.calls.length, 0);
});

test("prepareLocale notes are logged, formality reaches every batch, setup errors are not fatal", async () => {
  const dir = copyFixture();
  const provider = new MockProvider();
  const seen: string[] = [];
  (provider as unknown as { prepareLocale: (r: { targetLocale: string }) => Promise<string[]> }).prepareLocale = async (r) => {
    seen.push(r.targetLocale);
    if (r.targetLocale === "fr") throw new Error("glossary 400");
    return ["created glossary"];
  };
  const lines: string[] = [];
  const r = await run(dir, provider, { targets: ["de", "fr"], formality: "more", log: (l: string) => lines.push(l) });
  assert.equal(r.failedCount, 0);
  assert.deepEqual(seen.sort(), ["de", "fr"]);
  assert.ok(lines.includes("de: created glossary"));
  assert.ok(lines.some((l) => l.startsWith("fr: setup failed")));
  assert.ok(provider.calls.every((c) => c.formality === "more"));
});
