// Firefox Add-ons (AMO): push the translated listing with one PATCH.
// Ported from an earlier prototype (locales.ts, payload.ts, jwt.ts). Sources: the Mozilla addons-server API docs and source.
//
// - PATCH /api/v5/addons/addon/<id|slug|guid>/ with {name, summary, description} as locale -> text maps.
//   Locales not sent are left as they are; null deletes a locale.
// - Auth: "Authorization: JWT <token>", HS256, iss = API key, exp at most 5 minutes after iat.
//   https://addons-server.readthedocs.io/en/latest/topics/api/auth.html

import { createHmac, randomUUID } from 'node:crypto';
import { LISTING_FIELDS, type Listing, type ListingField } from '../listing.ts';

// Chrome -> AMO locale mapping.
//
// Sources (checked 2026-11-16):
// - Chrome Web Store locales: https://developer.chrome.com/docs/extensions/reference/api/i18n#locales
// - AMO locales: mozilla/addons-server src/olympia/core/languages.py (PROD_LANGUAGES),
//   used as AMO_LANGUAGES by src/olympia/conf/prod/settings.py.
//   Commit e9274a547adb34545aee8fc8fa53aa27394d8a40 (2026-11-13).
//   A PATCH with a locale key not in this list is rejected by
//   TranslationSerializerField ("The language code ... is invalid.").
//   Mozilla changes this list when translation completeness changes,
//   so callers can pass their own list.

/** Locales AMO production accepts in translated fields (PROD_LANGUAGES, 44 codes). */
export const AMO_PROD_LOCALES: readonly string[] = [
  'cs', 'de', 'dsb', 'el', 'en-CA', 'en-GB', 'en-US', 'es-AR', 'es-CL', 'es-ES',
  'es-MX', 'fa', 'fi', 'fr', 'fur', 'fy-NL', 'he', 'hr', 'hsb', 'hu', 'ia', 'it',
  'ja', 'ka', 'kab', 'ko', 'nb-NO', 'nl', 'nn-NO', 'pl', 'pt-BR', 'pt-PT', 'ro',
  'ru', 'sk', 'sl', 'sq', 'sr', 'sv-SE', 'tr', 'uk', 'vi', 'zh-CN', 'zh-TW',
];

type Alias = { amo: string[]; rule: 'alias' | 'fan-out'; source: string };

/**
 * Codes that cannot be mapped by replacing "_" with "-".
 * "addons-server" = SHORTER_LANGUAGES in src/olympia/lib/settings_base.py.
 * "our choice" = a decision of this project, not from Mozilla.
 */
const ALIASES: Record<string, Alias> = {
  en: { amo: ['en-US'], rule: 'alias', source: 'addons-server' },
  es: { amo: ['es-ES'], rule: 'alias', source: 'addons-server' },
  ga: { amo: ['ga-IE'], rule: 'alias', source: 'addons-server' },
  pt: { amo: ['pt-PT'], rule: 'alias', source: 'addons-server' },
  sv: { amo: ['sv-SE'], rule: 'alias', source: 'addons-server' },
  zh: { amo: ['zh-CN'], rule: 'alias', source: 'addons-server' },
  // Chrome "no" is Norwegian Bokmal in practice.
  no: { amo: ['nb-NO'], rule: 'alias', source: 'our choice' },
  // AMO falls back to the add-on default locale, not to another Spanish,
  // so we copy Latin American Spanish to every Latin American locale AMO has.
  es_419: { amo: ['es-AR', 'es-CL', 'es-MX'], rule: 'fan-out', source: 'our choice' },
};

/** Why some Chrome codes are skipped. Shown to the user as a warning. */
const SKIP_NOTES: Record<string, string> = {
  fil: 'AMO knows "tl" (Tagalog) but it is not enabled on production. Not folded into another locale.',
  en_AU: 'AMO knows "en-AU" but it is not enabled on production. Not folded into en-US/en-GB.',
};

export type MapResult =
  | {
      ok: true;
      chrome: string;
      amo: string[];
      rule: 'direct' | 'alias' | 'fan-out';
      source: string;
      /** Higher wins when two Chrome files map to the same AMO locale. */
      priority: number;
    }
  | { ok: false; chrome: string; reason: string };

/**
 * Map one Chrome locale code (e.g. "pt_BR") to AMO locale codes (e.g. ["pt-BR"]).
 * `supported` is the list of AMO locales the target server accepts.
 */
export function mapChromeLocale(
  chrome: string,
  supported: readonly string[] = AMO_PROD_LOCALES,
): MapResult {
  const byLower = new Map(supported.map((l) => [l.toLowerCase(), l]));

  const alias = ALIASES[chrome];
  if (alias) {
    // Partial fan-out is fine: send to the targets the server accepts.
    const amo = alias.amo
      .map((l) => byLower.get(l.toLowerCase()))
      .filter((l): l is string => l !== undefined);
    if (amo.length === 0) {
      return { ok: false, chrome, reason: `maps to ${alias.amo.join(', ')}, which AMO does not accept` };
    }
    return { ok: true, chrome, amo, rule: alias.rule, source: alias.source, priority: 1 };
  }

  const candidate = chrome.replace(/_/g, '-').toLowerCase();
  const canonical = byLower.get(candidate);
  if (canonical) {
    return { ok: true, chrome, amo: [canonical], rule: 'direct', source: 'same code', priority: 2 };
  }

  const reason = SKIP_NOTES[chrome] ?? `AMO does not accept "${chrome.replace(/_/g, '-')}"`;
  return { ok: false, chrome, reason };
}

/**
 * Resolve a locale given on the command line (for --remove).
 * Accepts an AMO code ("pt-BR") or a Chrome code ("pt_BR").
 */
export function resolveLocaleArg(arg: string, supported: readonly string[] = AMO_PROD_LOCALES): string[] {
  const exact = supported.find((l) => l.toLowerCase() === arg.toLowerCase());
  if (exact) return [exact];
  const mapped = mapChromeLocale(arg, supported);
  return mapped.ok ? mapped.amo : [];
}

// Build the JSON body for PATCH /api/v5/addons/addon/<id>/
//
// Translated field format (addons-server docs, "Translated Fields"):
//   { "name": { "en-US": "...", "de": "..." } }
// Locales not in the object are left as they are. A null value deletes that locale.
// The add-on default locale value cannot be deleted while other locales exist.


const FIELDS = LISTING_FIELDS;
type Field = ListingField;

/**
 * Max lengths from the Addon model in addons-server (src/olympia/addons/models.py):
 *   name = TranslatedField(max_length=50)
 *   summary = NoURLsField(max_length=250)
 *   description = PurifiedMarkdownField(max_length=15000)
 * The API returns 400 above these (addons-server tests test_fields_max_length,
 * test_set_data_too_long_other_textfields). We check them here too, so a bad file
 * fails before any request.
 */
export const AMO_LIMITS: Record<Field, number> = { name: 50, summary: 250, description: 15000 };

export type PatchBody = Partial<Record<Field, Record<string, string | null>>>;

export type BuildOptions = {
  /** AMO locales the server accepts. Default: AMO production list. */
  supported?: readonly string[];
  /** The add-on default locale on AMO. Its values are never deleted. Default "en-US". */
  defaultLocale?: string;
  /** Locales to delete (AMO or Chrome codes). Sends null for all three fields. */
  remove?: string[];
};

export type BuildResult = {
  body: PatchBody;
  /** Problems that must stop a real send. */
  errors: string[];
  /** Things the user should know, but that do not stop the send. */
  warnings: string[];
  /** Which Chrome file filled each AMO locale. */
  sources: Record<string, string>;
};

/** Length in Unicode code points. Python (the AMO server) counts this way, not in UTF-16 units. */
export function codePointLength(s: string): number {
  return [...s].length;
}

export function buildPatchBody(
  listings: Record<string, Listing>,
  options: BuildOptions = {},
): BuildResult {
  const supported = options.supported ?? AMO_PROD_LOCALES;
  const defaultLocale = options.defaultLocale ?? 'en-US';
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Pick the Chrome file for each AMO locale. A more specific file wins
  //    (e.g. en_US beats en for en-US). Equal priority is an error.
  const chosen = new Map<string, { chrome: string; priority: number }>();
  for (const chrome of Object.keys(listings).sort()) {
    const m = mapChromeLocale(chrome, supported);
    if (!m.ok) {
      warnings.push(`skip ${chrome}: ${m.reason}`);
      continue;
    }
    for (const amo of m.amo) {
      const prev = chosen.get(amo);
      if (!prev || m.priority > prev.priority) {
        if (prev) warnings.push(`${amo}: using ${chrome}, not the less specific ${prev.chrome}`);
        chosen.set(amo, { chrome, priority: m.priority });
      } else if (m.priority === prev.priority) {
        errors.push(`${chrome} and ${prev.chrome} both map to ${amo}; keep only one`);
      } else {
        warnings.push(`${amo}: using ${prev.chrome}, not the less specific ${chrome}`);
      }
    }
  }

  // 2. Check each used file once, then fill the body.
  const valid = new Map<string, Listing>();
  for (const chrome of new Set([...chosen.values()].map((c) => c.chrome))) {
    const listing = listings[chrome] ?? {};
    const ok: Listing = {};
    for (const field of FIELDS) {
      const value = listing[field];
      if (value === undefined) continue;
      if (typeof value !== 'string') {
        errors.push(`${chrome}.${field}: must be a string`);
        continue;
      }
      if (value.trim() === '') {
        errors.push(`${chrome}.${field}: empty; remove the key to leave it unchanged`);
        continue;
      }
      const len = codePointLength(value);
      if (len > AMO_LIMITS[field]) {
        errors.push(`${chrome}.${field}: ${len} characters, limit is ${AMO_LIMITS[field]}`);
      }
      ok[field] = value;
    }
    valid.set(chrome, ok);
  }

  const body: PatchBody = {};
  const sources: Record<string, string> = {};
  for (const [amo, { chrome }] of [...chosen].sort(([a], [b]) => a.localeCompare(b))) {
    sources[amo] = chrome;
    const listing = valid.get(chrome)!;
    for (const field of FIELDS) {
      const value = listing[field];
      if (value !== undefined) (body[field] ??= {})[amo] = value;
    }
  }

  // 3. Deletions.
  for (const arg of options.remove ?? []) {
    const locales = resolveLocaleArg(arg, supported);
    if (locales.length === 0) {
      errors.push(`--remove ${arg}: not a locale AMO accepts (the API rejects unknown locale keys, even with null)`);
      continue;
    }
    for (const amo of locales) {
      if (amo.toLowerCase() === defaultLocale.toLowerCase()) {
        errors.push(`--remove ${arg}: ${amo} is the default locale; AMO does not allow deleting it`);
        continue;
      }
      if (chosen.has(amo)) {
        errors.push(`--remove ${arg}: ${amo} also has a listing file (${chosen.get(amo)!.chrome})`);
        continue;
      }
      for (const field of FIELDS) (body[field] ??= {})[amo] = null;
    }
  }

  if (body.name || body.summary) {
    warnings.push('name/summary changes start an AMO content review (addons-server AddonSerializer.update)');
  }
  if (Object.keys(body).length === 0) {
    errors.push('nothing to send');
  }

  return { body, errors, warnings, sources };
}

// ---- JWT ----

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function signAmoJwt(
  issuer: string,
  secret: string,
  opts: { now?: number; ttlSeconds?: number; jti?: string } = {},
): string {
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const ttl = Math.min(opts.ttlSeconds ?? 60, 300);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { iss: issuer, jti: opts.jti ?? randomUUID(), iat, exp: iat + ttl };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}

export const AMO_HOST = 'https://addons.mozilla.org';

export function addonUrl(host: string, addon: string): string {
  return `${host.replace(/\/+$/, '')}/api/v5/addons/addon/${encodeURIComponent(addon)}/`;
}

/** AMO code for the add-on default locale, from the Chrome default_locale (en -> en-US). */
export function amoDefaultLocale(chromeDefault: string, supported: readonly string[] = AMO_PROD_LOCALES): string | null {
  const m = mapChromeLocale(chromeDefault, supported);
  return m.ok ? (m.amo[0] ?? null) : null;
}

/** Send the PATCH. Only called with an explicit --send and both env vars set. */
export async function sendPatch(
  url: string,
  body: PatchBody,
  creds: { issuer: string; secret: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; ok: boolean; text: string }> {
  const res = await fetchImpl(url, {
    method: 'PATCH',
    headers: {
      Authorization: `JWT ${signAmoJwt(creds.issuer, creds.secret)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, ok: res.ok, text: await res.text() };
}
