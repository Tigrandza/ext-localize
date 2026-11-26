import assert from "node:assert/strict";
import { test } from "node:test";
import { makeBatches } from "../src/batch.ts";
import { parseGlossary, termsFor } from "../src/glossary.ts";
import { CHROME_LOCALES, normalizeLocale, parseTargetLocales } from "../src/locales.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { deeplTargetCode, fromDeeplXml, toDeeplXml } from "../src/providers/deepl.ts";
import { buildUserPrompt, parseTranslations } from "../src/providers/prompt.ts";
import { OutputTruncatedError, ProviderError } from "../src/providers/types.ts";
import { HttpError, withRetry } from "../src/retry.ts";

test("there are 55 Chrome locales", () => {
  assert.equal(CHROME_LOCALES.length, 55);
});

test("normalizeLocale accepts common spellings", () => {
  assert.equal(normalizeLocale("pt-BR"), "pt_BR");
  assert.equal(normalizeLocale("PT_br"), "pt_BR");
  assert.equal(normalizeLocale("zh-cn"), "zh_CN");
  assert.equal(normalizeLocale("es-419"), "es_419");
  assert.equal(normalizeLocale("nb"), "no");
  assert.equal(normalizeLocale("iw"), "he");
  assert.equal(normalizeLocale("xx"), null);
  assert.equal(normalizeLocale("pt"), null);
});

test("parseTargetLocales: all = 54 targets without the source", () => {
  const all = parseTargetLocales("all", "en");
  assert.equal(all.length, 54);
  assert.ok(!all.includes("en"));
  assert.deepEqual(parseTargetLocales("de, pt-BR,en", "en"), ["de", "pt_BR"]);
  assert.throws(() => parseTargetLocales("de,klingon", "en"), /klingon/);
});

test("makeBatches respects item and size limits", () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, text: "x".repeat(10) }));
  assert.deepEqual(makeBatches(items, { maxItems: 10, maxChars: 1000 }).map((b) => b.length), [10, 10, 5]);
  assert.deepEqual(makeBatches(items, { maxItems: 100, maxChars: 45 }).map((b) => b.length), [4, 4, 4, 4, 4, 4, 1]);
});

test("glossary parsing normalizes locales and rejects bad input", () => {
  const g = parseGlossary({ keep: ["Brand"], terms: { tab: { "pt-BR": "aba", de: "Tab" } } });
  assert.deepEqual(termsFor(g, "pt_BR"), [["tab", "aba"]]);
  assert.throws(() => parseGlossary({ keep: "Brand" }), /array of strings/);
  assert.throws(() => parseGlossary({ terms: { tab: { klingon: "x" } } }), /unknown locale/);
});

test("withRetry retries 429 and 5xx, honours Retry-After, stops on 4xx", async () => {
  const delays: number[] = [];
  let n = 0;
  const value = await withRetry(
    async () => {
      n++;
      if (n === 1) throw new HttpError(429, "slow down", 2000);
      if (n === 2) throw new HttpError(503, "busy");
      return "ok";
    },
    { sleep: async (ms) => void delays.push(ms), baseDelayMs: 10 },
  );
  assert.equal(value, "ok");
  assert.equal(delays[0], 2000);
  assert.equal(delays.length, 2);
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new HttpError(400, "bad"); }, { sleep: async () => {} }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new HttpError(429, "x"); }, { retries: 3, sleep: async () => {} }));
  assert.equal(calls, 4);
});

test("DeepL: XML escaping around markers and code mapping", () => {
  const sent = toDeeplXml('Tom & Jerry <b> <x id="0"/> <x id="1">R&D</x>');
  assert.equal(sent, 'Tom &amp; Jerry &lt;b&gt; <x id="0"/> <x id="1">R&amp;D</x>');
  assert.equal(fromDeeplXml('Tom &amp; Jerry &lt;b&gt; <x id="0"/>'), 'Tom & Jerry <b> <x id="0"/>');
  assert.equal(deeplTargetCode("pt_BR"), "PT-BR");
  assert.equal(deeplTargetCode("zh_TW"), "ZH-HANT");
  assert.equal(deeplTargetCode("no"), "NB");
  assert.equal(deeplTargetCode("fil"), "TL");
  assert.equal(deeplTargetCode("de"), "DE");
});

test("LLM prompt contains descriptions, marker notes and glossary; parser keeps only requested keys", () => {
  const req = {
    sourceLocale: "en",
    targetLocale: "pt_BR",
    terms: [["tab", "aba"]] as [string, string][],
    items: [{ key: "a", text: 'Hi <x id="0"/>', description: "Greeting", markerHints: ['<x id="0"/> = placeholder $name$'] }],
  };
  const prompt = buildUserPrompt(req);
  assert.match(prompt, /Brazilian Portuguese \(pt_BR\)/);
  assert.match(prompt, /"description": "Greeting"/);
  assert.match(prompt, /"tab" -> "aba"/);
  assert.deepEqual(parseTranslations('{"translations":[{"key":"a","text":"Oi"},{"key":"zzz","text":"?"}]}', req), { a: "Oi" });
  assert.throws(() => parseTranslations("not json", req), ProviderError);
});

/** Minimal fake of the SDK surface the provider uses. */
function fakeClient(response: Record<string, unknown>, seen: Record<string, unknown>[]) {
  return {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          seen.push(params);
          return response;
        },
      },
    },
  } as never;
}

const REQ = { sourceLocale: "en", targetLocale: "de", terms: [] as [string, string][], items: [{ key: "a", text: "Apple" }] };

test("Anthropic provider: request shape and response parsing", async () => {
  const seen: Record<string, unknown>[] = [];
  const p = new AnthropicProvider({
    client: fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: '{"translations":[{"key":"a","text":"Apfel"}]}' }] }, seen),
  });
  assert.deepEqual(await p.translateBatch(REQ), { a: "Apfel" });
  const params = seen[0] as { model: string; fallbacks: string; betas: string[]; output_config: { effort: string; format: { type: string } }; temperature?: number };
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.fallbacks, "default");
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(params.output_config.format.type, "json_schema");
  assert.equal(params.output_config.effort, "medium");
  assert.equal(params.temperature, undefined);
  assert.equal(p.label, "anthropic/claude-opus-5-5");
});

test("Anthropic provider: refusal and max_tokens are handled before reading content", async () => {
  const refused = new AnthropicProvider({ client: fakeClient({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }, []) });
  await assert.rejects(refused.translateBatch(REQ), /declined.*cyber/);
  const cut = new AnthropicProvider({ client: fakeClient({ stop_reason: "max_tokens", content: [] }, []) });
  await assert.rejects(cut.translateBatch(REQ), OutputTruncatedError);
});
