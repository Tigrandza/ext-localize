/**
 * Locales that the Chrome Web Store and chrome.i18n accept as folder names
 * under _locales/. Source: https://developer.chrome.com/docs/extensions/reference/api/i18n
 */
export const CHROME_LOCALES = [
  "ar", "am", "bg", "bn", "ca", "cs", "da", "de", "el", "en", "en_AU", "en_GB",
  "en_US", "es", "es_419", "et", "fa", "fi", "fil", "fr", "gu", "he", "hi", "hr",
  "hu", "id", "it", "ja", "kn", "ko", "lt", "lv", "ml", "mr", "ms", "nl", "no",
  "pl", "pt_BR", "pt_PT", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "te",
  "th", "tr", "uk", "vi", "zh_CN", "zh_TW",
] as const;

export type ChromeLocale = (typeof CHROME_LOCALES)[number];

const CHROME_LOCALE_SET: ReadonlySet<string> = new Set(CHROME_LOCALES);

/** Locales written right to left. They get an extra warning-level check. */
export const RTL_LOCALES: ReadonlySet<string> = new Set(["ar", "he", "fa"]);

/** Common codes people type that Chrome spells differently. */
const ALIASES: Record<string, string> = {
  nb: "no",
  nn: "no",
  iw: "he",
  tl: "fil",
  "zh_hans": "zh_CN",
  "zh_hant": "zh_TW",
};

export function isChromeLocale(code: string): code is ChromeLocale {
  return CHROME_LOCALE_SET.has(code);
}

/**
 * Turn user input like "pt-BR", "PT_br", "zh-cn" or "es-419" into the Chrome
 * folder spelling ("pt_BR", "zh_CN", "es_419"). Returns null when the result
 * is not a Chrome locale.
 */
export function normalizeLocale(input: string): string | null {
  const raw = input.trim().replace(/-/g, "_");
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  const [lang, ...rest] = lower.split("_");
  let code = lang ?? "";
  if (rest.length > 0) {
    const region = rest.join("_");
    code += "_" + (/^\d+$/.test(region) ? region : region.toUpperCase());
  }
  return isChromeLocale(code) ? code : null;
}

/**
 * Parse a --to value: "all", or a comma separated list. Throws on unknown codes.
 * The source locale is always removed: we never write to it.
 */
export function parseTargetLocales(value: string, sourceLocale: string): string[] {
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  const out = new Set<string>();
  const unknown: string[] = [];
  for (const part of parts) {
    if (part.toLowerCase() === "all") {
      for (const l of CHROME_LOCALES) out.add(l);
      continue;
    }
    const n = normalizeLocale(part);
    if (n) out.add(n);
    else unknown.push(part);
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown locale code(s): ${unknown.join(", ")}. Chrome supports: ${CHROME_LOCALES.join(", ")}`,
    );
  }
  out.delete(sourceLocale);
  return [...out].sort();
}

/** "pt_BR" -> "pt-BR", for Intl and for prompts. */
export function toBcp47(locale: string): string {
  return locale.replace(/_/g, "-");
}

/** Human name of a locale in English, e.g. "Brazilian Portuguese". */
export function localeDisplayName(locale: string): string {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    return names.of(toBcp47(locale)) ?? locale;
  } catch {
    return locale;
  }
}
