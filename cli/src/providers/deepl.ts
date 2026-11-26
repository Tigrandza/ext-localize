import { fetchJson, withRetry } from "../retry.ts";
import { createHash } from "node:crypto";
import type { BatchLimits, BatchRequest, Formality, LocaleRequest, Provider } from "./types.ts";
import { ProviderError } from "./types.ts";

/** Chrome locale -> DeepL target code, where they differ from plain upper case. */
const TARGET_MAP: Record<string, string> = {
  en: "EN-US",
  en_US: "EN-US",
  en_GB: "EN-GB",
  en_AU: "EN-GB",
  es_419: "ES-419",
  pt_BR: "PT-BR",
  pt_PT: "PT-PT",
  zh_CN: "ZH-HANS",
  zh_TW: "ZH-HANT",
  no: "NB",
  fil: "TL",
};

export function deeplTargetCode(locale: string): string {
  return TARGET_MAP[locale] ?? locale.split("_")[0]!.toUpperCase();
}

/** DeepL source codes are language-only (EN, PT, ZH). */
export function deeplSourceCode(locale: string): string {
  return locale === "fil" ? "TL" : locale === "no" ? "NB" : locale.split("_")[0]!.toUpperCase();
}

const MARKER_SPLIT_RE = /(<x id="\d+"\/>|<x id="\d+">[\s\S]*?<\/x>)/;

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Escape the text between markers so DeepL's XML mode sees well-formed input. */
export function toDeeplXml(text: string): string {
  return text
    .split(MARKER_SPLIT_RE)
    .map((part, i) =>
      i % 2 === 1 ? part.replace(/>([\s\S]*?)<\/x>$/, (_m, inner: string) => `>${escapeXml(inner)}</x>`) : escapeXml(part),
    )
    .join("");
}

export function fromDeeplXml(text: string): string {
  return text
    .split(/(<x\s[^>]*\/>|<x\s[^>]*>[\s\S]*?<\/x>)/)
    .map((part, i) => (i % 2 === 1 ? part : unescapeXml(part)))
    .join("");
}

export interface DeepLOptions {
  apiKey?: string;
  /** Default: DEEPL_API_URL, else api-free.deepl.com for keys ending in ":fx", else api.deepl.com. */
  baseUrl?: string;
}

/** What we send for one target locale, decided once in prepareLocale(). */
interface LocaleSetup {
  formality?: Formality;
  glossaryId?: string;
}

/**
 * Turn glossary terms into DeepL TSV entries. DeepL rejects empty phrases,
 * tabs or line breaks inside a phrase, leading/trailing spaces and duplicate
 * source terms, so those are trimmed or dropped (with a note).
 */
export function glossaryEntries(terms: [string, string][]): { tsv: string; count: number; dropped: string[] } {
  const seen = new Set<string>();
  const lines: string[] = [];
  const dropped: string[] = [];
  for (const [rawSource, rawTarget] of terms) {
    const source = rawSource.trim();
    const target = rawTarget.trim();
    if (!source || !target || /[\t\r\n\u2028\u2029]/.test(source + target)) {
      dropped.push(rawSource);
      continue;
    }
    if (seen.has(source)) {
      dropped.push(rawSource);
      continue;
    }
    seen.add(source);
    lines.push(`${source}\t${target}`);
  }
  // Sorted, so the same terms always give the same glossary name.
  lines.sort();
  return { tsv: lines.join("\n"), count: lines.length, dropped };
}

/** Name of the DeepL glossary for one language pair and one set of entries. */
export function glossaryName(source: string, target: string, tsv: string): string {
  const hash = createHash("sha256").update(tsv, "utf8").digest("hex").slice(0, 16);
  return `${GLOSSARY_PREFIX}${source}->${target} ${hash}`;
}

export const GLOSSARY_PREFIX = "ext-localize ";

/** DeepL accepts at most 50 texts per /v2/translate request. */
export const DEEPL_MAX_TEXTS = 50;

/** Split text into lines; each line keeps its leading and trailing spaces apart. */
export function splitLines(text: string): { lead: string; core: string; trail: string }[] {
  return text.split(/\r?\n/).map((line) => {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(line) as RegExpExecArray;
    return { lead: m[1] ?? "", core: m[2] ?? "", trail: m[3] ?? "" };
  });
}

/**
 * DeepL /v2/translate. Markers are sent as XML tags with tag_handling=xml and
 * ignore_tags=["x"], so placeholders and "keep" terms are never touched.
 * Descriptions go into the per-request "context" field (not billed).
 *
 * Formality: "more"/"less" are sent only to languages that support them
 * (others get the default, with a note); "prefer_more"/"prefer_less" are
 * always sent, DeepL falls back by itself.
 *
 * Glossary terms: one DeepL glossary (v3 API) per target locale, named by a
 * hash of its entries. An existing glossary with the same name is reused, so
 * a new one is created only when the terms change. Old ones are not deleted.
 */
export class DeepLProvider implements Provider {
  readonly name = "deepl";
  readonly label = "deepl";
  readonly limits: BatchLimits = { maxItems: 50, maxChars: 30000 };
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private targets: Promise<Map<string, { formality: boolean }>> | undefined;
  private glossaryLangs: Promise<Map<string, string>> | undefined;
  private glossaries: Promise<Map<string, string>> | undefined;
  private readonly setup = new Map<string, LocaleSetup>();

  constructor(opts: DeepLOptions = {}) {
    const key = opts.apiKey ?? process.env.DEEPL_API_KEY;
    if (!key) throw new ProviderError("DEEPL_API_KEY is not set");
    this.apiKey = key;
    this.baseUrl = (
      opts.baseUrl ??
      process.env.DEEPL_API_URL ??
      (key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com")
    ).replace(/\/+$/, "");
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = { authorization: `DeepL-Auth-Key ${this.apiKey}` };
    if (json) h["content-type"] = "application/json";
    return h;
  }

  private get(path: string): Promise<unknown> {
    return withRetry(() => fetchJson(`${this.baseUrl}${path}`, { method: "GET", headers: this.headers(false) }));
  }

  /** Target languages of this account, with formality support (free call, cached). */
  private targetLanguages(): Promise<Map<string, { formality: boolean }>> {
    this.targets ??= this.get("/v2/languages?type=target").then(
      (list) =>
        new Map(
          (list as { language: string; supports_formality?: boolean }[]).map((l) => [
            l.language.toUpperCase(),
            { formality: l.supports_formality === true },
          ]),
        ),
    );
    return this.targets;
  }

  async supportsLocale(locale: string): Promise<boolean> {
    return (await this.targetLanguages()).has(deeplTargetCode(locale));
  }

  /** Languages usable in glossaries: upper-case code -> code as DeepL spells it. */
  private glossaryLanguages(): Promise<Map<string, string>> {
    this.glossaryLangs ??= this.get("/v3/languages?resource=glossary").then(
      (list) => new Map((list as { lang: string }[]).map((l) => [l.lang.toUpperCase(), l.lang])),
    );
    return this.glossaryLangs;
  }

  /** Our glossaries on this account: name -> id (cached for the run). */
  private glossaryIndex(): Promise<Map<string, string>> {
    this.glossaries ??= this.get("/v3/glossaries").then((data) => {
      const list = (data as { glossaries?: { glossary_id: string; name: string }[] }).glossaries ?? [];
      return new Map(list.filter((g) => g.name.startsWith(GLOSSARY_PREFIX)).map((g) => [g.name, g.glossary_id]));
    });
    return this.glossaries;
  }

  private async ensureGlossary(source: string, target: string, tsv: string): Promise<{ id: string; created: boolean; name: string }> {
    const name = glossaryName(source, target, tsv);
    const index = await this.glossaryIndex();
    const existing = index.get(name);
    if (existing) return { id: existing, created: false, name };
    const body = { name, dictionaries: [{ source_lang: source, target_lang: target, entries: tsv, entries_format: "tsv" }] };
    // Not wrapped in withRetry: a retried POST could create the glossary twice.
    const created = (await fetchJson(`${this.baseUrl}/v3/glossaries`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    })) as { glossary_id?: string };
    if (!created.glossary_id) throw new ProviderError("DeepL did not return a glossary_id");
    index.set(name, created.glossary_id);
    return { id: created.glossary_id, created: true, name };
  }

  /** Decide formality and glossary for one locale. Returns notes for the log. */
  async prepareLocale(req: LocaleRequest): Promise<string[]> {
    const notes: string[] = [];
    const setup: LocaleSetup = {};
    const target = deeplTargetCode(req.targetLocale);

    if (req.formality && req.formality !== "default") {
      const lang = (await this.targetLanguages()).get(target);
      if (req.formality.startsWith("prefer_") || lang?.formality) setup.formality = req.formality;
      else notes.push(`formality "${req.formality}" is not supported for ${target}; using the default`);
    }

    if (req.terms.length) {
      const { tsv, count, dropped } = glossaryEntries(req.terms);
      if (dropped.length) notes.push(`glossary terms not usable on DeepL (empty, tab, line break or duplicate): ${dropped.join(", ")}`);
      const langs = await this.glossaryLanguages();
      const src = langs.get(deeplSourceCode(req.sourceLocale));
      const tgt = langs.get(target);
      if (count === 0) {
        // nothing left to send
      } else if (!src || !tgt) {
        notes.push(`DeepL glossaries do not support ${deeplSourceCode(req.sourceLocale)} -> ${target}; glossary terms not applied`);
      } else {
        const g = await this.ensureGlossary(src, tgt, tsv);
        setup.glossaryId = g.id;
        notes.push(`${g.created ? "created" : "using"} DeepL glossary "${g.name}" (${count} term${count === 1 ? "" : "s"})`);
      }
    }
    this.setup.set(req.targetLocale, setup);
    return notes;
  }

  async translateBatch(req: BatchRequest): Promise<Record<string, string>> {
    let context: string;
    if (req.kind === "listing") {
      context = "Store listing of a browser extension: the name, a short summary, and the long description.";
    } else {
      // DeepL has one context per request and never sees our keys, so each note
      // quotes the source text it belongs to. This is loose background only.
      const notes = req.items
        .filter((i) => i.description)
        .map((i) => `"${i.text}": ${i.description}`)
        .join("\n");
      context = notes ? `Strings from a Chrome browser extension user interface. Notes per string:\n${notes}` : "";
    }
    const params: Record<string, unknown> = {
      source_lang: deeplSourceCode(req.sourceLocale),
      target_lang: deeplTargetCode(req.targetLocale),
      tag_handling: "xml",
      ignore_tags: ["x"],
      preserve_formatting: true,
    };
    if (context) params.context = context;
    const setup = this.setup.get(req.targetLocale);
    if (setup) {
      if (setup.formality) params.formality = setup.formality;
      if (setup.glossaryId) params.glossary_id = setup.glossaryId;
    } else if (req.formality?.startsWith("prefer_")) {
      params.formality = req.formality;
    }

    // Listing text: each line is sent as its own text. In XML mode DeepL does not
    // treat a line break as the end of a sentence, so list items could be merged.
    // Blank lines and the spaces around a line are kept here and never sent.
    // UI messages are sent whole, as before.
    const split = req.items.map((item) => (req.kind === "listing" ? splitLines(item.text) : [{ lead: "", core: item.text, trail: "" }]));
    const texts = split.flatMap((lines) => lines.filter((l) => l.core !== "" || lines.length === 1).map((l) => toDeeplXml(l.core)));
    const out: string[] = [];
    for (let i = 0; i < texts.length; i += DEEPL_MAX_TEXTS) {
      const chunk = texts.slice(i, i + DEEPL_MAX_TEXTS);
      const body = { ...params, text: chunk };
      const data = (await withRetry(() =>
        fetchJson(`${this.baseUrl}/v2/translate`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }),
      )) as { translations?: { text: string }[] };
      const list = data.translations ?? [];
      if (list.length !== chunk.length) {
        throw new ProviderError(`DeepL returned ${list.length} texts for ${chunk.length} inputs`);
      }
      out.push(...list.map((t) => fromDeeplXml(t.text)));
    }
    const result: Record<string, string> = {};
    let n = 0;
    req.items.forEach((item, i) => {
      const lines = split[i] ?? [];
      result[item.key] = lines
        .map((l) => (l.core === "" && lines.length > 1 ? l.lead + l.trail : l.lead + (out[n++] ?? "") + l.trail))
        .join("\n");
    });
    return result;
  }
}
