import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadGlossary } from "../src/glossary.ts";
import { defaultListingTargets, listingJob, loadListing } from "../src/listing.ts";
import { loadProject } from "../src/messages.ts";
import { buildUserPrompt, parseTranslations, systemPromptFor, SHORTEN_SYSTEM_PROMPT } from "../src/providers/prompt.ts";
import { DeepLProvider } from "../src/providers/deepl.ts";
import { OllamaProvider } from "../src/providers/ollama.ts";
import { HttpError } from "../src/retry.ts";
import { loadState } from "../src/state.ts";
import { runJob, SHORTEN_ATTEMPTS, translateProject } from "../src/translate.ts";
import { MockProvider, copyFixture, makeExtension } from "./helpers.ts";

// 0.3.2: live Ollama run (qwen3:8b, 2026-11-27): even with the limit in the prompt, German and
// Spanish names and summaries of two extensions came back 93-175 characters for limits of 75 / 132.
// Now a too-long answer is sent back with a "make it shorter" request, up to SHORTEN_ATTEMPTS times.

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function longNameListing(): string {
  const dir = copyFixture();
  const src = readJson(join(dir, "listing/en.json"));
  src.name = "N".repeat(48); // the mock answer "[de] NNN..." is 53 characters; Firefox limit is 50
  writeFileSync(join(dir, "listing/en.json"), JSON.stringify(src));
  return dir;
}

async function listingRun(dir: string, provider: MockProvider, stores: ("chrome" | "firefox")[] = ["chrome", "firefox"]) {
  const project = loadProject(dir);
  const lp = loadListing(project, join(dir, "listing"));
  return runJob(listingJob(project, lp, stores), loadState(dir, project.defaultLocale), {
    provider,
    glossary: loadGlossary(dir),
    targets: ["de"],
  });
}

const shortenCalls = (p: MockProvider) => p.calls.filter((c) => c.kind === "shorten");

test("listing: a name over the limit is sent back to be shortened, and the short answer is written", async () => {
  const dir = longNameListing();
  const provider = new MockProvider({ shorten: () => "Kurzer Name" });
  const r = await listingRun(dir, provider);
  assert.deepEqual(r.locales[0]!.failed, []);
  assert.equal(readJson(join(dir, "listing/de.json")).name, "Kurzer Name");
  const sc = shortenCalls(provider);
  assert.equal(sc.length, 1);
  assert.deepEqual(sc[0]!.items.map((i) => i.key), ["name"]);
  assert.deepEqual(sc[0]!.items[0]!.shorten, { previous: `[de] ${"N".repeat(48)}`, length: 53, max: 50 });
  // Not re-sent with the normal prompt first: one translate pass + one shorten request.
  assert.equal(provider.calls.filter((c) => c.kind !== "shorten").flatMap((c) => c.items).filter((i) => i.key === "name").length, 1);
});

test("listing: still too long after every shorten request -> reported as before, not written", async () => {
  const dir = longNameListing();
  // Answers get shorter, but never fit (limit 50).
  const provider = new MockProvider({ shorten: (item) => "M".repeat(Math.max(51, (item.shorten?.length ?? 60) - 1)) });
  const r = await listingRun(dir, provider);
  const failed = r.locales[0]!.failed;
  assert.deepEqual(failed.map((f) => f.key), ["name"]);
  assert.match(failed[0]!.error, /too long: 51 characters, limit 50; still too long after 3 shorten requests \(answers: 52, 51, 51\)/);
  assert.equal(shortenCalls(provider).length, SHORTEN_ATTEMPTS);
  // The second request starts from the shorter answer of the first.
  assert.equal(shortenCalls(provider)[1]!.items[0]!.shorten?.previous, "M".repeat(52));
  assert.equal(readJson(join(dir, "listing/de.json")).name, undefined);
});

test("listing: a shorten answer that breaks a marker is ignored", async () => {
  const dir = copyFixture();
  const src = readJson(join(dir, "listing/en.json"));
  // Glossary keep-term in a summary over the 132 limit (the fixture glossary keeps "TabNest").
  src.summary = `TabNest ${"s".repeat(126)}`;
  writeFileSync(join(dir, "listing/en.json"), JSON.stringify(src));
  const provider = new MockProvider({ shorten: () => "short, marker lost" });
  const r = await listingRun(dir, provider, ["chrome"]);
  const failed = r.locales[0]!.failed;
  assert.deepEqual(failed.map((f) => f.key), ["summary"]);
  assert.match(failed[0]!.error, /too long: 139 characters, limit 132; still too long after 3 shorten requests \(answers: broken, broken, broken\)/);
});

test("manifest name over its hint is shortened; if shortening fails, the long text is still written", async () => {
  const files = {
    "manifest.json": { manifest_version: 3, name: "__MSG_appName__", description: "__MSG_appDesc__", version: "1", default_locale: "en" },
    "_locales/en/messages.json": {
      appName: { message: "A".repeat(72), description: "Product name." },
      appDesc: { message: "D".repeat(130) },
      other: { message: "Hello" },
    },
  };
  const ok = makeExtension(files);
  const p1 = new MockProvider({ shorten: (i) => (i.key === "appName" ? "Kurz" : undefined) });
  const lines: string[] = [];
  const r1 = await translateProject(loadProject(ok), loadState(ok), { targets: ["de"], provider: p1, log: (l: string) => lines.push(l) });
  assert.ok(lines.includes("de > appDesc: written with 135 characters, limit 132; still too long after 3 shorten requests (answers: no answer (got appName), no answer, no answer)"), lines.join("\n"));
  assert.ok(lines.some((l) => /^de: 3 translated.*, 1 shortened/.test(l)), lines.join("\n"));
  assert.equal(r1.failedCount, 0);
  const de = readJson(join(ok, "_locales/de/messages.json"));
  assert.equal(de.appName.message, "Kurz");
  assert.equal(de.appDesc.message, `[de] ${"D".repeat(130)}`); // no answer: the long one stays (check warns)
  assert.equal(de.other.message, "[de] Hello");
  assert.deepEqual(shortenCalls(p1)[0]!.items.map((i) => i.key).sort(), ["appDesc", "appName"]);
  assert.equal(shortenCalls(p1).length, SHORTEN_ATTEMPTS); // appDesc asked again, appName done after the first
  assert.deepEqual(shortenCalls(p1)[1]!.items.map((i) => i.key), ["appDesc"]);
});

test("a provider that cannot shorten (DeepL, plain mock) gets no shorten request", async () => {
  const dir = longNameListing();
  const provider = new MockProvider();
  const r = await listingRun(dir, provider);
  assert.equal(shortenCalls(provider).length, 0);
  assert.match(r.locales[0]!.failed[0]!.error, /^too long: 53 characters, limit 50$/);
  assert.equal(new DeepLProvider({ apiKey: "x:fx" }).canShorten, undefined);
  assert.equal(new OllamaProvider({ model: "m" }).canShorten, true);
});

test("a fatal error during shortening stops the run", async () => {
  const dir = longNameListing();
  const provider = new MockProvider({
    shorten: () => "x",
    throwFor: (req) => (req.kind === "shorten" ? new HttpError(401, "bad key") : undefined),
  });
  const r = await listingRun(dir, provider);
  assert.match(r.stopped ?? "", /bad key/);
  assert.equal(shortenCalls(provider).length, 1);
  assert.deepEqual(r.locales[0]!.failed.map((f) => f.key), ["name"]);
});

test("shorten prompt carries the long translation, its length and the limit", () => {
  assert.equal(systemPromptFor("shorten"), SHORTEN_SYSTEM_PROMPT);
  const prompt = buildUserPrompt({
    sourceLocale: "en",
    targetLocale: "de",
    terms: [],
    kind: "shorten",
    items: [{ key: "name", text: "Otto", description: "Product name.", shorten: { previous: "Otto – sehr langer Name", length: 93, max: 75 } }],
  });
  const start = prompt.indexOf("(JSON):\n") + "(JSON):\n".length;
  const json = JSON.parse(prompt.slice(start, prompt.indexOf("\n\nReturn", start)));
  assert.deepEqual(json, [
    { key: "name", source: "Otto", description: "Product name.", too_long_translation: "Otto – sehr langer Name", length: 93, max_length: 75, cut_at_least: 18, target_length: 67 },
  ]);
  assert.match(prompt, /at most its max_length characters/);
});

test("one string asked, one answer under another key: the answer is used", () => {
  const req = { sourceLocale: "en", targetLocale: "de", terms: [], items: [{ key: "extName", text: "Otto" }] };
  assert.deepEqual(parseTranslations('{"translations":[{"key":"name","text":"Otto kurz"}]}', req), { extName: "Otto kurz" });
  // With two strings asked, a wrong key is still dropped.
  const two = { ...req, items: [...req.items, { key: "extDescription", text: "D" }] };
  assert.deepEqual(parseTranslations('{"translations":[{"key":"name","text":"x"}]}', two), {});
});
