import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeLocale } from "./locales.ts";
import { localizerDir } from "./paths.ts";

/**
 * Glossary file (default: .localizer/glossary.json).
 *
 * {
 *   "keep": ["TabNest", "Chrome"],                 // never translated
 *   "terms": {                                     // fixed translation per locale
 *     "workspace": { "de": "Arbeitsbereich", "fr": "espace de travail" }
 *   }
 * }
 *
 * "keep" terms are hard-protected (swapped for markers), so every provider
 * keeps them. "terms" are sent to LLM providers as instructions; DeepL cannot
 * use them without a server-side glossary, so they are ignored there.
 */
export interface Glossary {
  keep: string[];
  /** term -> locale -> fixed translation. Locale keys are normalized (pt-BR -> pt_BR). */
  terms: Record<string, Record<string, string>>;
}

export const EMPTY_GLOSSARY: Glossary = { keep: [], terms: {} };

export function defaultGlossaryPath(root: string): string {
  return join(localizerDir(root), "glossary.json");
}

export function parseGlossary(data: unknown, label = "glossary"): Glossary {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${label}: must be a JSON object`);
  const obj = data as Record<string, unknown>;
  const keep: string[] = [];
  if (obj.keep !== undefined) {
    if (!Array.isArray(obj.keep) || obj.keep.some((t) => typeof t !== "string")) {
      throw new Error(`${label}: "keep" must be an array of strings`);
    }
    keep.push(...(obj.keep as string[]).filter((t) => t.trim()));
  }
  const terms: Glossary["terms"] = {};
  if (obj.terms !== undefined) {
    if (!obj.terms || typeof obj.terms !== "object" || Array.isArray(obj.terms)) {
      throw new Error(`${label}: "terms" must be an object`);
    }
    for (const [term, map] of Object.entries(obj.terms as Record<string, unknown>)) {
      if (!map || typeof map !== "object" || Array.isArray(map)) {
        throw new Error(`${label}: terms["${term}"] must be an object of locale -> translation`);
      }
      const byLocale: Record<string, string> = {};
      for (const [loc, value] of Object.entries(map as Record<string, unknown>)) {
        const n = normalizeLocale(loc);
        if (!n) throw new Error(`${label}: terms["${term}"] has unknown locale "${loc}"`);
        if (typeof value !== "string") throw new Error(`${label}: terms["${term}"]["${loc}"] must be a string`);
        byLocale[n] = value;
      }
      terms[term] = byLocale;
    }
  }
  return { keep, terms };
}

/**
 * Load the glossary. An explicit path must exist; the default path is optional.
 */
export function loadGlossary(root: string, explicitPath?: string): Glossary {
  const path = explicitPath ?? defaultGlossaryPath(root);
  if (!existsSync(path)) {
    if (explicitPath) throw new Error(`Glossary file not found: ${explicitPath}`);
    return EMPTY_GLOSSARY;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: invalid JSON: ${(e as Error).message}`);
  }
  return parseGlossary(data, path);
}

/** Fixed translations that apply to one locale: [[term, translation], ...]. */
export function termsFor(glossary: Glossary, locale: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [term, map] of Object.entries(glossary.terms)) {
    const t = map[locale];
    if (t !== undefined) out.push([term, t]);
  }
  return out;
}
