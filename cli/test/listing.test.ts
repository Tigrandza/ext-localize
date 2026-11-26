import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { checkProject } from "../src/check.ts";
import { parseConfig, parseStores } from "../src/config.ts";
import { loadGlossary } from "../src/glossary.ts";
import { checkListing, defaultListingTargets, limitsFor, listingJob, loadListing, ListingError } from "../src/listing.ts";
import { loadProject } from "../src/messages.ts";
import { DeepLProvider, splitLines } from "../src/providers/deepl.ts";
import { buildUserPrompt, systemPromptFor } from "../src/providers/prompt.ts";
import type { BatchRequest } from "../src/providers/types.ts";
import { loadState } from "../src/state.ts";
import { runJob, translateProject } from "../src/translate.ts";
import { OutputTruncatedError } from "../src/providers/types.ts";
import { MockProvider, copyFixture, makeExtension } from "./helpers.ts";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

async function listingRun(dir: string, provider: MockProvider | undefined, extra: Record<string, unknown> = {}) {
  const project = loadProject(dir);
  const state = loadState(dir, project.defaultLocale);
  const lp = loadListing(project, join(dir, "listing"));
  const stores = (extra.stores as ("chrome" | "firefox" | "edge")[] | undefined) ?? ["chrome"];
  return runJob(listingJob(project, lp, stores), state, {
    provider,
    glossary: loadGlossary(dir),
    targets: (extra.targets as string[] | undefined) ?? defaultListingTargets(project, lp.dir),
    ...extra,
  });
}

async function messagesRun(dir: string, provider: MockProvider, targets: string[]) {
  const project = loadProject(dir);
  return translateProject(project, loadState(dir, project.defaultLocale), { provider, glossary: loadGlossary(dir), targets });
}

test("listing: translates name, summary and description when _locales has no such locale", async () => {
  const dir = copyFixture();
  const provider = new MockProvider();
  const r = await listingRun(dir, provider, { targets: ["de"] });
  assert.equal(r.failedCount, 0);
  const de = readJson(join(dir, "listing/de.json"));
  assert.deepEqual(Object.keys(de), ["name", "summary", "description"]);
  assert.ok(de.description.startsWith("[de] "));
  // "$4.99" is plain text in a listing: no markers, kept as is.
  assert.ok(de.description.includes("$4.99"));
  const sent = provider.calls[0]!;
  assert.equal(sent.kind, "listing");
  const desc = sent.items.find((i) => i.key === "description")!;
  assert.ok(!desc.text.includes('<x id="0"/>$') && desc.text.includes("$4.99"));
  assert.ok(desc.text.includes('<x id="0">TabNest</x>'), "keep terms are still protected");
  assert.match(desc.description ?? "", /Maximum length: 16000 characters/);
  const state = readJson(join(dir, ".localizer/state.json"));
  assert.deepEqual(Object.keys(state.locales.de.listing), ["description", "name", "summary"]);
  assert.deepEqual(state.locales.de.messages, {});
});

test("listing: name and summary are copied from _locales when the manifest uses __MSG_", async () => {
  const dir = copyFixture();
  const provider = new MockProvider();
  await messagesRun(dir, provider, ["de"]);
  provider.calls = [];
  await listingRun(dir, provider, { targets: ["de"] });
  assert.deepEqual(provider.calls.flatMap((c) => c.items.map((i) => i.key)), ["description"]);
  const de = readJson(join(dir, "listing/de.json"));
  const msgs = readJson(join(dir, "_locales/de/messages.json"));
  assert.equal(de.name, msgs.extName.message);
  assert.equal(de.summary, msgs.extDescription.message);
  const state = readJson(join(dir, ".localizer/state.json"));
  assert.equal(state.locales.de.listing.name.by, "_locales");
  // The messages section survived the listing run.
  assert.ok(Object.keys(state.locales.de.messages).length > 20);
});

test("listing: a messages run keeps the listing state, and the reverse", async () => {
  const dir = copyFixture();
  const provider = new MockProvider();
  await listingRun(dir, provider, { targets: ["de"] });
  await messagesRun(dir, provider, ["de"]);
  const state = readJson(join(dir, ".localizer/state.json"));
  assert.ok(state.locales.de.listing?.description, "listing state must not be wiped by a messages run");
  assert.ok(state.locales.de.messages.extName);
});

test("listing: only the changed field is sent again; a second run sends nothing", async () => {
  const dir = copyFixture();
  const provider = new MockProvider();
  await listingRun(dir, provider, { targets: ["de"] });
  provider.calls = [];
  const again = await listingRun(dir, provider, { targets: ["de"] });
  assert.equal(again.totalRequests, 0);

  const src = readJson(join(dir, "listing/en.json"));
  src.description.push("New line at the end.");
  writeFileSync(join(dir, "listing/en.json"), JSON.stringify(src, null, 2));
  const r = await listingRun(dir, provider, { targets: ["de"] });
  assert.deepEqual(provider.calls.flatMap((c) => c.items.map((i) => i.key)), ["description"]);
  assert.equal(r.locales[0]!.plan.translate[0]!.reason, "changed");
});

test("listing: a hand edit that changes '$4.99' is kept, not treated as broken", async () => {
  const dir = copyFixture();
  const provider = new MockProvider();
  await listingRun(dir, provider, { targets: ["de"] });
  const path = join(dir, "listing/de.json");
  const de = readJson(path);
  de.description = de.description.replace("$4.99", "4,99 €");
  writeFileSync(path, JSON.stringify(de, null, 2));
  provider.calls = [];
  const r = await listingRun(dir, provider, { targets: ["de"] });
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(r.locales[0]!.plan.manual, ["description"]);
  assert.ok(readJson(path).description.includes("4,99 €"));
});

test("listing: a translation over the store limit is not written", async () => {
  const dir = copyFixture();
  // Firefox name limit is 50; the mock adds "[de] " and the name is 37 characters, so make it longer.
  const src = readJson(join(dir, "listing/en.json"));
  src.name = "N".repeat(48);
  writeFileSync(join(dir, "listing/en.json"), JSON.stringify(src));
  const r = await listingRun(dir, new MockProvider(), { targets: ["de"], stores: ["chrome", "firefox"] });
  const failed = r.locales[0]!.failed;
  assert.deepEqual(failed.map((f) => f.key), ["name"]);
  assert.match(failed[0]!.error, /too long: 53 characters, limit 50/);
  assert.equal(readJson(join(dir, "listing/de.json")).name, undefined);
});

test("listing: a description too long for one answer fails alone; name and summary are still written", async () => {
  const dir = copyFixture();
  const provider = new MockProvider({
    throwFor: (req) => (req.items.some((i) => i.key === "description") ? new OutputTruncatedError() : undefined),
  });
  const r = await listingRun(dir, provider, { targets: ["de"] });
  assert.equal(r.stopped, undefined);
  assert.deepEqual(r.locales[0]!.failed.map((f) => f.key), ["description"]);
  const de = readJson(join(dir, "listing/de.json"));
  assert.ok(de.name.startsWith("[de] "));
  assert.ok(de.summary.startsWith("[de] "));
  assert.equal(de.description, undefined);
});

test("listing: a missing source file is a clear error", () => {
  const dir = copyFixture();
  rmSync(join(dir, "listing/en.json"));
  assert.throws(() => loadListing(loadProject(dir), join(dir, "listing")), ListingError);
});

test("listing: limitsFor takes the tightest store limit", () => {
  assert.deepEqual(limitsFor(["chrome"]), { name: 75, summary: 132, description: 16000 });
  assert.deepEqual(limitsFor(["chrome", "firefox", "edge"]), { name: 50, summary: 132, description: 10000 });
});

test("listing: dry run counts without writing", async () => {
  const dir = copyFixture();
  const r = await listingRun(dir, undefined, { targets: ["de", "fr"], dryRun: true });
  assert.equal(r.totalStrings, 6);
  assert.ok(!existsSync(join(dir, "listing/de.json")));
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

function listingExtension(listing: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return makeExtension({
    "manifest.json": { manifest_version: 3, name: "__MSG_extName__", description: "__MSG_extDesc__", version: "1", default_locale: "en" },
    "_locales/en/messages.json": { extName: { message: "Tab Tidy" }, extDesc: { message: "Tidy tabs." } },
    "_locales/de/messages.json": { extName: { message: "Tab Tidy" }, extDesc: { message: "Tabs aufräumen." } },
    ...Object.fromEntries(Object.entries(listing).map(([k, v]) => [`listing/${k}`, v])),
    ...extra,
  });
}

test("check: no listing folder gives the same report as before", () => {
  const dir = makeExtension({
    "manifest.json": { manifest_version: 3, name: "__MSG_extName__", version: "1", default_locale: "en" },
    "_locales/en/messages.json": { extName: { message: "X" } },
  });
  const r = checkProject(dir, { stores: ["chrome", "firefox", "edge"] });
  assert.deepEqual(r.issues, []);
});

test("check: store limits apply only to the chosen stores", () => {
  const long = "x".repeat(60);
  const dir = listingExtension({
    "en.json": { description: "Long text." },
    "de.json": { name: long, summary: "Tabs aufräumen.", description: "Text." },
  });
  const chrome = checkProject(dir, { stores: ["chrome"] });
  assert.ok(!chrome.issues.some((i) => i.level === "error"));
  const firefox = checkProject(dir, { stores: ["chrome", "firefox"] });
  const err = firefox.issues.find((i) => i.level === "error");
  assert.equal(err?.locale, "de");
  assert.equal(err?.key, "listing.name");
  assert.match(err!.message, /60 characters; Firefox Add-ons \(AMO\) limit is 50/);
});

test("check: a listing name that differs from _locales is a warning", () => {
  const dir = listingExtension({
    "en.json": { description: "Long text." },
    "de.json": { name: "Tab Tidy", summary: "Alte Zusammenfassung", description: "Text." },
  });
  const r = checkProject(dir);
  const w = r.issues.filter((i) => i.level === "warning");
  assert.equal(w.length, 1);
  assert.equal(w[0]!.key, "listing.summary");
  assert.match(w[0]!.message, /differs from _locales\/de extDesc/);
  assert.equal(r.errors, 0);
});

test("check: bad file names, bad JSON, missing source and empty fields are errors", () => {
  const dir = listingExtension(
    {
      "de.json": "{ not json",
      "pt-BR.json": { name: "a", summary: "b", description: "c" },
      "fr.json": { name: "", summary: "s", description: ["array only allowed in the source"] },
    },
  );
  const r = checkProject(dir);
  const msgs = r.issues.filter((i) => i.level === "error").map((i) => `${i.locale}: ${i.message}`);
  assert.ok(msgs.some((m) => m.startsWith("en: listing: no source file")), msgs.join("\n"));
  assert.ok(msgs.some((m) => m.startsWith("de: listing: listing/de.json: invalid JSON")));
  assert.ok(msgs.some((m) => m.startsWith("pt-BR: listing: file name")));
  assert.ok(msgs.some((m) => m.startsWith('fr: listing: listing/fr.json: "description" must be a string')));
  assert.ok(msgs.some((m) => m.startsWith('fr: listing: "name" is empty')));
});

test("check: firefox and edge text rules", () => {
  const dir = listingExtension({
    "en.json": { summary: "Tidy tabs.", description: "# Heading\nShort." },
  });
  const issues = checkListing(loadProject(dir), join(dir, "listing"), ["firefox", "edge"]);
  const messages = issues.map((i) => i.message);
  assert.ok(messages.some((m) => m.includes("AMO drops Markdown headings")));
  assert.ok(messages.some((m) => m.includes("Edge Add-ons needs at least 250")));
});

// ---------------------------------------------------------------------------
// prompts and DeepL line handling
// ---------------------------------------------------------------------------

test("listing requests use the listing system prompt", () => {
  assert.match(systemPromptFor("listing"), /store listing/);
  assert.match(systemPromptFor(undefined), /user interface strings/);
  const req: BatchRequest = { sourceLocale: "en", targetLocale: "de", terms: [], kind: "listing", items: [{ key: "name", text: "X" }] };
  assert.match(buildUserPrompt(req), /"key": "name"/);
});

test("splitLines keeps blank lines and the spaces around each line", () => {
  assert.deepEqual(splitLines("a\n\n  - b "), [
    { lead: "", core: "a", trail: "" },
    { lead: "", core: "", trail: "" },
    { lead: "  ", core: "- b", trail: " " },
  ]);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("DeepL sends each line on its own and rebuilds the text; more than 50 lines are split into requests", async () => {
  const sent: string[][] = [];
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { text: string[]; context?: string };
    sent.push(body.text);
    return new Response(JSON.stringify({ translations: body.text.map((t) => ({ text: `DE:${t}` })) }), { status: 200 });
  }) as typeof fetch;
  const p = new DeepLProvider({ apiKey: "k:fx" });
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const out = await p.translateBatch({
    sourceLocale: "en",
    targetLocale: "de",
    terms: [],
    kind: "listing",
    items: [
      { key: "description", text: "Intro.\n\n- one\n  - two" },
      { key: "long", text: long },
    ],
  });
  assert.equal(out.description, "DE:Intro.\n\nDE:- one\n  DE:- two");
  assert.equal(out.long!.split("\n").length, 60);
  assert.deepEqual(sent.map((s) => s.length), [50, 13]);
  assert.ok(sent[0]!.every((t) => !t.includes("\n")));
});

test("DeepL sends UI messages whole, line breaks included (unchanged behavior)", async () => {
  const sent: string[][] = [];
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { text: string[] };
    sent.push(body.text);
    return new Response(JSON.stringify({ translations: body.text.map((t) => ({ text: `DE:${t}` })) }), { status: 200 });
  }) as typeof fetch;
  const p = new DeepLProvider({ apiKey: "k:fx" });
  const out = await p.translateBatch({ sourceLocale: "en", targetLocale: "de", terms: [], items: [{ key: "a", text: " Line one\nline two " }] });
  assert.deepEqual(sent, [[" Line one\nline two "]]);
  assert.equal(out.a, "DE: Line one\nline two ");
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test("config: unknown keys, bad types and bad values are errors", () => {
  assert.throws(() => parseConfig({ provder: "deepl" }), /unknown setting "provder"/);
  assert.throws(() => parseConfig({ chrome: { itme: "x" } }), /unknown setting "chrome.itme"/);
  assert.throws(() => parseConfig({ stores: ["opera"] }), /unknown store "opera"/);
  assert.throws(() => parseConfig({ formality: "polite" }), /formality/);
  assert.throws(() => parseConfig({ firefox: { extraLocales: "ar" } }), /must be an array of strings/);
  assert.deepEqual(parseConfig({ to: ["de", "fr"] }), { to: "de,fr" });
  assert.deepEqual(parseStores("chrome, firefox,chrome"), ["chrome", "firefox"]);
});

test("config file in the fixture is valid", () => {
  const dir = copyFixture();
  mkdirSync(join(dir, "x"), { recursive: true });
  const c = parseConfig(readJson(join(dir, ".localizer/config.json")));
  assert.equal(c.firefox?.addon, "tabnest");
});
