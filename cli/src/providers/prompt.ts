import { localeDisplayName } from "../locales.ts";
import type { BatchRequest } from "./types.ts";
import { ProviderError } from "./types.ts";

/**
 * Shared prompt for LLM providers (Anthropic, OpenAI, Ollama).
 * The system prompt is constant so providers can cache it.
 */
export const SYSTEM_PROMPT = `You translate user interface strings of a Chrome browser extension.

Rules:
1. Markers like <x id="0"/> stand for placeholders that the extension fills in at runtime. Copy every marker exactly once, unchanged, at the natural position for the target language.
2. Markers like <x id="1">Name</x> wrap words that must not be translated. Copy them exactly, including the inner text.
3. Never add, remove, merge or rename markers.
4. Keep the meaning and tone. UI text must stay short: aim for a length close to the source.
5. The description and marker notes are context for you. Do not translate or include them.
6. Keep leading and trailing spaces, line breaks and punctuation style that the target language allows.
7. When a glossary is given, always use its translations for those terms.
8. Return one entry for every input key, with the key unchanged.`;

/** Instructions for store listing text (name, summary, long description). */
export const LISTING_SYSTEM_PROMPT = `You translate the store listing of a browser extension (Chrome Web Store, Firefox Add-ons, Edge Add-ons).

Rules:
1. Markers like <x id="1">Name</x> wrap words that must not be translated. Copy them exactly, including the inner text. Never add, remove or rename markers.
2. Write natural, fluent marketing text for the target language. Keep the meaning; do not add claims or keywords that are not in the source.
3. Keep the structure of the long description: the same paragraphs, line breaks, list markers ("- ", "* ", "1. ") and blank lines.
4. Respect the maximum length given in the description of each string.
5. The description of each string is context for you. Do not translate or include it.
6. When a glossary is given, always use its translations for those terms.
7. Return one entry for every input key, with the key unchanged.`;

export function systemPromptFor(kind: "messages" | "listing" | undefined): string {
  return kind === "listing" ? LISTING_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

/** JSON schema for the structured response: an array, since keys are dynamic. */
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          text: { type: "string" },
        },
        required: ["key", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["translations"],
  additionalProperties: false,
} as const;

export function buildUserPrompt(req: BatchRequest): string {
  const lines: string[] = [];
  lines.push(`Source language: ${localeDisplayName(req.sourceLocale)} (${req.sourceLocale})`);
  lines.push(`Target language: ${localeDisplayName(req.targetLocale)} (${req.targetLocale})`);
  if (req.formality === "more" || req.formality === "prefer_more") {
    lines.push("Tone: formal. Use the formal form of address where the language has one (for example German \"Sie\", French \"vous\").");
  } else if (req.formality === "less" || req.formality === "prefer_less") {
    lines.push("Tone: informal. Use the informal form of address where the language has one (for example German \"du\", French \"tu\").");
  }
  if (req.terms.length) {
    lines.push("", "Glossary (always use these translations):");
    for (const [term, translation] of req.terms) lines.push(`- "${term}" -> "${translation}"`);
  }
  const items = req.items.map((i) => {
    const o: Record<string, unknown> = { key: i.key, text: i.text };
    if (i.description) o.description = i.description;
    if (i.markerHints?.length) o.markers = i.markerHints;
    return o;
  });
  lines.push("", "Strings to translate (JSON):", JSON.stringify(items, null, 1));
  lines.push("", `Return {"translations": [{"key": ..., "text": ...}]} with ${req.items.length} entries.`);
  return lines.join("\n");
}

/** Parse the model's JSON answer into key -> text. Unknown keys are ignored. */
export function parseTranslations(raw: string, req: BatchRequest): Record<string, string> {
  let data: unknown;
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new ProviderError(`model did not return valid JSON: ${raw.slice(0, 200)}`);
  }
  const list = (data as { translations?: unknown })?.translations;
  if (!Array.isArray(list)) throw new ProviderError(`model JSON has no "translations" array`);
  const wanted = new Set(req.items.map((i) => i.key));
  const out: Record<string, string> = {};
  for (const entry of list) {
    const e = entry as { key?: unknown; text?: unknown };
    if (typeof e?.key === "string" && typeof e.text === "string" && wanted.has(e.key)) out[e.key] = e.text;
  }
  return out;
}
