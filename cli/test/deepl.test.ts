import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DeepLProvider, glossaryEntries, glossaryName } from "../src/providers/deepl.ts";
import { buildUserPrompt } from "../src/providers/prompt.ts";
import type { BatchRequest } from "../src/providers/types.ts";
import { classifyError } from "../src/translate.ts";

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Fake DeepL server. `existing` = glossaries already on the account. */
function fakeDeepL(opts: { existing?: { glossary_id: string; name: string }[]; glossaryStatus?: number } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.endsWith("/v2/languages?type=target")) {
      return json([
        { language: "DE", supports_formality: true },
        { language: "AR", supports_formality: false },
        { language: "PT-BR", supports_formality: true },
        { language: "TH", supports_formality: false },
      ]);
    }
    if (url.endsWith("/v3/languages?resource=glossary")) {
      return json([{ lang: "en" }, { lang: "de" }, { lang: "ar" }, { lang: "pt-BR" }]);
    }
    if (url.endsWith("/v3/glossaries") && method === "GET") return json({ glossaries: opts.existing ?? [] });
    if (url.endsWith("/v3/glossaries") && method === "POST") {
      if (opts.glossaryStatus) return json({ message: "nope" }, opts.glossaryStatus);
      return json({ glossary_id: "g-new", name: body?.name }, 201);
    }
    if (url.endsWith("/v2/translate")) {
      const texts = body?.text as string[];
      return json({ translations: texts.map((t) => ({ text: `T:${t}` })) });
    }
    return json({ message: "not found" }, 404);
  }) as typeof fetch;
  return calls;
}

const base = (targetLocale: string, extra: Partial<BatchRequest> = {}): BatchRequest => ({
  sourceLocale: "en",
  targetLocale,
  terms: [],
  items: [{ key: "a", text: "Create workspace" }],
  ...extra,
});

const translateCall = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/v2/translate")).at(-1)!;

test("formality 'more' is sent to a language that supports it", async () => {
  const calls = fakeDeepL();
  const p = new DeepLProvider({ apiKey: "k:fx" });
  const notes = await p.prepareLocale(base("de", { formality: "more" }));
  assert.deepEqual(notes, []);
  await p.translateBatch(base("de", { formality: "more" }));
  assert.equal(translateCall(calls).body?.formality, "more");
});

test("formality 'more' is left out (with a note) where DeepL does not support it", async () => {
  const calls = fakeDeepL();
  const p = new DeepLProvider({ apiKey: "k:fx" });
  const notes = await p.prepareLocale(base("ar", { formality: "more" }));
  assert.match(notes[0]!, /not supported for AR/);
  await p.translateBatch(base("ar", { formality: "more" }));
  assert.equal(translateCall(calls).body?.formality, undefined);
});

test("prefer_more is always sent; DeepL falls back by itself", async () => {
  const calls = fakeDeepL();
  const p = new DeepLProvider({ apiKey: "k:fx" });
  await p.prepareLocale(base("ar", { formality: "prefer_more" }));
  await p.translateBatch(base("ar", { formality: "prefer_more" }));
  assert.equal(translateCall(calls).body?.formality, "prefer_more");
});

test("glossary terms create a DeepL glossary once and its id is used", async () => {
  const calls = fakeDeepL();
  const p = new DeepLProvider({ apiKey: "k:fx" });
  const req = base("pt_BR", { terms: [["workspace", "espaço de trabalho"]] });
  const notes = await p.prepareLocale(req);
  assert.match(notes[0]!, /^created DeepL glossary "ext-localize en->pt-BR [0-9a-f]{16}" \(1 term\)$/);
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/v3/glossaries"))!;
  assert.deepEqual(post.body?.dictionaries, [
    { source_lang: "en", target_lang: "pt-BR", entries: "workspace\tespaço de trabalho", entries_format: "tsv" },
  ]);
  await p.translateBatch(req);
  const t = translateCall(calls);
  assert.equal(t.body?.glossary_id, "g-new");
  assert.equal(t.body?.source_lang, "EN");
  assert.equal(t.body?.target_lang, "PT-BR");
});

test("an existing glossary with the same terms is reused, not created again", async () => {
  const name = glossaryName("en", "de", "workspace\tArbeitsbereich");
  const calls = fakeDeepL({ existing: [{ glossary_id: "g-old", name }, { glossary_id: "other", name: "someone else's" }] });
  const p = new DeepLProvider({ apiKey: "k:fx" });
  const notes = await p.prepareLocale(base("de", { terms: [["workspace", "Arbeitsbereich"]] }));
  assert.match(notes[0]!, /^using DeepL glossary/);
  assert.equal(calls.filter((c) => c.method === "POST" && c.url.endsWith("/v3/glossaries")).length, 0);
  await p.translateBatch(base("de"));
  assert.equal(translateCall(calls).body?.glossary_id, "g-old");
});

test("changed terms give a new glossary name", () => {
  assert.notEqual(glossaryName("en", "de", "a\tb"), glossaryName("en", "de", "a\tc"));
});

test("a language without glossary support gets a note and no glossary", async () => {
  const calls = fakeDeepL();
  const p = new DeepLProvider({ apiKey: "k:fx" });
  const notes = await p.prepareLocale(base("th", { terms: [["workspace", "x"]] }));
  assert.match(notes[0]!, /do not support EN -> TH/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("glossary entries: trimmed, sorted, bad and duplicate terms dropped", () => {
  const r = glossaryEntries([
    ["  tab ", " Tab "],
    ["workspace", "Arbeitsbereich"],
    ["tab", "Reiter"],
    ["bad\tterm", "x"],
    ["empty", "  "],
  ]);
  assert.equal(r.tsv, "tab\tTab\nworkspace\tArbeitsbereich");
  assert.equal(r.count, 2);
  assert.deepEqual(r.dropped, ["tab", "bad\tterm", "empty"]);
});

test("a glossary auth error is fatal for the run", async () => {
  fakeDeepL({ glossaryStatus: 403 });
  const p = new DeepLProvider({ apiKey: "k:fx" });
  await assert.rejects(p.prepareLocale(base("de", { terms: [["workspace", "Arbeitsbereich"]] })), (e: unknown) => classifyError(e) === "fatal");
});

test("LLM prompt gets a tone line for formality", () => {
  assert.match(buildUserPrompt(base("de", { formality: "more" })), /Tone: formal/);
  assert.match(buildUserPrompt(base("de", { formality: "prefer_less" })), /Tone: informal/);
  assert.doesNotMatch(buildUserPrompt(base("de", { formality: "default" })), /Tone:/);
});
