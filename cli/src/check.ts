import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RTL_LOCALES, isChromeLocale } from "./locales.ts";
import { compareFormat, summarizeFormat, tokenize } from "./placeholders.ts";
import { listLocaleDirs, messagesPath, readMessagesFile, stripJsonComments } from "./messages.ts";
import type { Store } from "./config.ts";
import { checkListing, listingDir } from "./listing.ts";
import { configBase, localeFileRel, localesDirFor, localesRel, manifestPathFor, manifestRel, relPath } from "./paths.ts";
import { loadGlossary } from "./glossary.ts";
import { findStale, type StaleCheck, type StaleMode } from "./stale.ts";
import { familyMember, pluralCategories, pluralFamilies } from "./plurals.ts";

export interface CheckOptions {
  /** Stores whose listing limits apply. Default: ["chrome"]. */
  stores?: readonly Store[];
  /** Listing folder: absolute, or relative to the folder holding .localizer (the extension folder by default). Default: "listing". */
  listingDir?: string;
  /** Level for stale strings, or "off". Default: "warning". */
  stale?: StaleMode;
  /** Glossary "keep" terms (ignored by the RTL check). Default: from the default glossary file, if any. */
  keep?: readonly string[];
  /** Only listing checks (plus project-level problems). */
  listingOnly?: boolean;
  /** Key patterns (`*` matches any run of characters, case-insensitive) whose issues are dropped. */
  ignoreKeys?: readonly string[];
  /** Level for "missing (present in source)" in a non-default locale. Chrome falls back to the default locale. Default: "error". */
  missingKeys?: Level;
}

/** Turn ignoreKeys patterns into one test. `*` is the only wildcard; matching is case-insensitive like Chrome keys. */
export function keyMatcher(patterns: readonly string[]): (key: string) => boolean {
  const res = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new RegExp(`^${p.split("*").map(escapeRegExp).join(".*")}$`, "i"));
  return (key) => res.some((re) => re.test(key));
}

export type Level = "error" | "warning";

export interface Issue {
  level: Level;
  /** Set for issues from the stale check: "stale" (one stale string) or "state" (state file unusable). */
  kind?: "stale" | "state";
  /** Locale folder name, or null for project-level problems (manifest). */
  locale: string | null;
  key?: string;
  message: string;
  /** File the issue is about, relative to the extension folder, with "/" separators. */
  file?: string;
  /** 1-based line in that file, when it can be found. */
  line?: number;
}

export interface CheckReport {
  defaultLocale: string | null;
  locales: string[];
  issues: Issue[];
  errors: number;
  warnings: number;
  /** Number of stale strings (issues with kind "stale"). */
  stale: number;
  staleCheck: StaleCheck;
}

/** Message keys may only use these characters (Chrome i18n docs). */
export const KEY_RE = /^[A-Za-z0-9_@]+$/;

/** Manifest fields with Chrome Web Store length limits. Warning level. */
const MANIFEST_LIMITS: Record<string, number> = { name: 75, short_name: 12, description: 132 };

/** Hebrew, Arabic (incl. Persian) script blocks and presentation forms. */
const RTL_CHAR_RE = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/;

function plainText(message: string): string {
  return tokenize(message)
    .filter((s) => s.kind === "text")
    .map((s) => s.raw)
    .join("");
}

function asEntry(value: unknown): { message?: unknown; placeholders?: unknown } | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Checks on key names and message shape that apply to every locale file. */
function checkEntries(data: Record<string, unknown>, locale: string): Issue[] {
  const issues: Issue[] = [];
  const err = (key: string, message: string) => issues.push({ level: "error", locale, key, message });
  const lowerSeen = new Map<string, string>();
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("@@")) err(key, `keys starting with "@@" are reserved by Chrome`);
    else if (!KEY_RE.test(key)) err(key, `invalid key name; use only A-Z a-z 0-9 _ @`);
    const lower = key.toLowerCase();
    const prev = lowerSeen.get(lower);
    if (prev !== undefined) err(key, `duplicate of "${prev}" (keys are case-insensitive)`);
    else lowerSeen.set(lower, key);

    const entry = asEntry(value);
    if (!entry) {
      err(key, `value must be an object with a "message" field`);
      continue;
    }
    if (typeof entry.message !== "string") {
      err(key, `missing "message" string`);
      continue;
    }
    if (entry.message.trim() === "") err(key, `empty message`);

    // Every $name$ used must be defined in this file's own placeholders block.
    const defined = new Set<string>();
    const ph = asEntry(entry.placeholders);
    if (entry.placeholders !== undefined && !ph) err(key, `"placeholders" must be an object`);
    if (ph) {
      for (const [name, def] of Object.entries(ph)) {
        defined.add(name.toLowerCase());
        if (!KEY_RE.test(name)) err(key, `invalid placeholder name "${name}"`);
        const d = asEntry(def);
        if (!d || typeof (d as { content?: unknown }).content !== "string") {
          err(key, `placeholder "${name}" needs a "content" string`);
        }
      }
    }
    for (const name of summarizeFormat(entry.message).named) {
      if (!defined.has(name)) err(key, `$${name}$ is used but not defined in "placeholders"`);
    }
  }
  return issues;
}

/** Validate the default locale file on its own. */
export function checkSource(data: Record<string, unknown>, locale: string): Issue[] {
  const issues = checkEntries(data, locale);
  for (const [key, value] of Object.entries(data)) {
    const entry = asEntry(value);
    if (!entry || typeof entry.message !== "string") continue;
    const s = summarizeFormat(entry.message);
    if (s.lone > 0) {
      issues.push({ level: "warning", locale, key, message: `stray "$" in message; use "$$" for a literal dollar sign` });
    }
    const ph = asEntry(entry.placeholders);
    if (ph) {
      for (const name of Object.keys(ph)) {
        if (!s.named.includes(name.toLowerCase())) {
          issues.push({ level: "warning", locale, key, message: `placeholder "${name}" is defined but not used` });
        }
      }
    }
  }
  return issues;
}

/** Validate one translated locale against the source. Pure; used by `check` and tests. */
/**
 * RTL check: does a message in ar/he/fa look untranslated? Quiet on purpose:
 * glossary "keep" terms are ignored, and so are messages with fewer than 4 letters
 * (A4, KB, v1.x) and short ones (up to 3 words) identical to the source (brand names).
 */
export function looksUntranslated(target: string, source: string, keep: readonly string[] = []): boolean {
  let text = plainText(target);
  if (RTL_CHAR_RE.test(text)) return false;
  for (const term of [...keep].sort((a, b) => b.length - a.length)) if (term.trim()) text = text.split(term).join(" ");
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 4) return false;
  const words = plainText(target).trim().split(/\s+/).filter(Boolean).length;
  if (plainText(target).trim() === plainText(source).trim() && words <= 3) return false;
  return true;
}

export function checkLocale(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  locale: string,
  opts: { keep?: readonly string[]; missingKeys?: Level } = {},
): Issue[] {
  const issues = checkEntries(target, locale);
  const err = (key: string, message: string) => issues.push({ level: "error", locale, key, message });
  const warn = (key: string, message: string) => issues.push({ level: "warning", locale, key, message });

  const targetByLower = new Map(Object.keys(target).map((k) => [k.toLowerCase(), k]));
  const sourceLower = new Set(Object.keys(source).map((k) => k.toLowerCase()));
  const families = pluralFamilies(Object.keys(source));

  for (const [key, srcValue] of Object.entries(source)) {
    const tKey = targetByLower.get(key.toLowerCase());
    if (tKey === undefined) {
      // items_one is not needed in Japanese: its plural rules have no "one".
      const member = familyMember(key, families, locale);
      if (!member || member.used) issues.push({ level: opts.missingKeys ?? "error", locale, key, message: `missing (present in source)` });
      continue;
    }
    if (tKey !== key) warn(key, `key spelled "${tKey}" here; same key for Chrome, but keep the source spelling`);
    const src = asEntry(srcValue);
    const tgt = asEntry(target[tKey]);
    if (!src || typeof src.message !== "string" || !tgt || typeof tgt.message !== "string") continue;

    for (const p of compareFormat(src.message, tgt.message)) (p.severity === "error" ? err : warn)(key, p.message);

    if (RTL_LOCALES.has(locale) && looksUntranslated(tgt.message, src.message, opts.keep)) {
      warn(key, `no right-to-left letters; message may be untranslated`);
    }
  }
  for (const key of Object.keys(target)) {
    if (sourceLower.has(key.toLowerCase())) continue;
    const member = familyMember(key, families, locale);
    if (!member) {
      err(key, `extra key (not in source)`);
      continue;
    }
    if (!member.used) {
      warn(key, `plural form "${member.category}" is not used in ${locale} (Intl.PluralRules); Chrome never needs it`);
      continue;
    }
    // items_few has no source key: compare its placeholders with the source items_other.
    const otherKey = Object.keys(source).find((k) => k.toLowerCase() === `${member.base}_other`);
    const src = otherKey ? asEntry(source[otherKey]) : null;
    const tgt = asEntry(target[key]);
    if (src && typeof src.message === "string" && tgt && typeof tgt.message === "string") {
      for (const p of compareFormat(src.message, tgt.message)) (p.severity === "error" ? err : warn)(key, `${p.message} (compared with ${otherKey})`);
    }
  }
  // Plural forms the locale's language uses but the locale file does not have.
  for (const base of families) {
    const otherKey = Object.keys(source).find((k) => k.toLowerCase() === `${base}_other`) as string;
    const prefix = otherKey.slice(0, otherKey.length - "_other".length);
    for (const cat of pluralCategories(locale)) {
      const k = `${prefix}_${cat}`;
      if (sourceLower.has(k.toLowerCase()) || targetByLower.has(k.toLowerCase())) continue;
      warn(k, `plural form "${cat}" is missing; ${locale} uses it (Intl.PluralRules), and the source has no such key to fall back to`);
    }
  }
  return issues;
}

/** Look up a __MSG_key__ value in a locale (case-insensitive key). */
function lookupMessage(data: Record<string, unknown>, key: string): string | undefined {
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(data)) {
    const e = asEntry(v);
    if (k.toLowerCase() === lower && e && typeof e.message === "string") return e.message;
  }
  return undefined;
}

/** Run every check on an extension folder. */
export function checkProject(root: string, opts: CheckOptions = {}): CheckReport {
  const issues: Issue[] = [];
  const listingAbs = listingDir(root, opts.listingDir, configBase(root));
  const listingRel = relPath(root, listingAbs);
  let staleCheck: StaleCheck = {
    mode: opts.stale ?? "warning",
    status: "no-source",
    stale: 0,
    untracked: 0,
    note: "The source messages could not be read, so stale strings were not checked.",
  };
  const localesDir = localesDirFor(root);
  const localesPrefix = `${localesRel(root)}/`;
  const report = (): CheckReport => {
    annotate(root, issues, listingRel);
    if (opts.ignoreKeys?.length) {
      const ignored = keyMatcher(opts.ignoreKeys);
      issues.splice(0, issues.length, ...issues.filter((i) => !i.key || !ignored(i.key)));
    }
    if (opts.listingOnly) {
      // Keep listing issues and project-level problems (no manifest, no default locale...).
      const listingPrefix = listingRel === "." ? "" : `${listingRel}/`;
      const keepIssue = (i: Issue) =>
        i.key?.startsWith("listing.") || (i.file !== undefined && i.file.startsWith(listingPrefix) && i.file.endsWith(".json") && !i.file.startsWith(localesPrefix)) || (i.locale === null && i.kind !== "state");
      issues.splice(0, issues.length, ...issues.filter(keepIssue));
      staleCheck = { ...staleCheck, stale: issues.filter((i) => i.kind === "stale").length };
    }
    return {
      defaultLocale,
      locales,
      issues,
      errors: issues.filter((i) => i.level === "error").length,
      warnings: issues.filter((i) => i.level === "warning").length,
      stale: issues.filter((i) => i.kind === "stale").length,
      staleCheck,
    };
  };
  let defaultLocale: string | null = null;
  let locales: string[] = [];

  const manifestPath = manifestPathFor(root);
  const manifestFile = manifestRel(root);
  if (!existsSync(manifestPath)) {
    issues.push({ level: "error", locale: null, message: manifestFile === "manifest.json" ? `no manifest.json in ${root}` : `manifest not found: ${manifestPath}` });
    return report();
  }
  let manifest: Record<string, unknown>;
  try {
    let raw = readFileSync(manifestPath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    manifest = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
  } catch (e) {
    issues.push({ level: "error", locale: null, message: `${manifestFile} does not parse: ${(e as Error).message}` });
    return report();
  }

  locales = listLocaleDirs(localesDir);
  const dl = manifest["default_locale"];
  if (typeof dl !== "string" || !dl) {
    if (locales.length) issues.push({ level: "error", locale: null, message: `${localesPrefix} exists but manifest.json has no "default_locale"` });
    return report();
  }
  defaultLocale = dl;
  if (!locales.includes(dl)) {
    issues.push({ level: "error", locale: dl, message: `default_locale "${dl}" has no ${localeFileRel(root, dl)}` });
    return report();
  }

  const parsed = new Map<string, Record<string, unknown>>();
  for (const locale of locales) {
    if (!isChromeLocale(locale)) {
      issues.push({
        level: "warning",
        locale,
        message: `"${locale}" is not in the Chrome Web Store locale list, so the store will not offer it; the Chrome runtime may still use it (for example "nb" for Norwegian)`,
      });
    }
    const path = messagesPath(localesDir, locale);
    if (!existsSync(path)) {
      issues.push({ level: "error", locale, message: `folder has no messages.json (Chrome refuses to load the extension)` });
      continue;
    }
    const r = readMessagesFile(path);
    if (!r.ok) {
      issues.push({ level: "error", locale, message: `${r.error} (Chrome drops this locale)` });
      continue;
    }
    if (r.hadBom) issues.push({ level: "warning", locale, message: `file starts with a byte order mark (BOM); save as UTF-8 without BOM` });
    parsed.set(locale, r.data);
  }

  const source = parsed.get(dl);
  if (!source) return report();
  let keep = opts.keep;
  if (!keep) {
    try {
      keep = loadGlossary(root).keep;
    } catch {
      keep = []; // a broken glossary is reported by translate
    }
  }
  issues.push(...checkSource(source, dl));

  // Manifest __MSG_key__ references must exist in the source.
  const manifestText = JSON.stringify(manifest);
  for (const m of manifestText.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
    const key = m[1] as string;
    if (key.startsWith("@@")) continue;
    if (lookupMessage(source, key) === undefined) {
      issues.push({ level: "error", locale: dl, key, message: `${manifestFile} uses __MSG_${key}__ but the key is missing`, file: manifestFile });
    }
  }

  for (const [locale, data] of parsed) {
    if (locale !== dl) issues.push(...checkLocale(source, data, locale, { keep, missingKeys: opts.missingKeys }));
    // Store length limits for localized manifest fields.
    for (const [field, max] of Object.entries(MANIFEST_LIMITS)) {
      const value = manifest[field];
      const ref = typeof value === "string" ? /^__MSG_([A-Za-z0-9_@]+)__$/.exec(value) : null;
      if (!ref) continue;
      const text = lookupMessage(data, ref[1] as string);
      if (text !== undefined && [...text].length > max) {
        issues.push({ level: "warning", locale, key: ref[1], message: `manifest "${field}" is ${[...text].length} chars; the limit is ${max}` });
      }
    }
  }
  // Store listing (only when the listing folder exists).
  issues.push(...checkListing({ manifest, localesDir, defaultLocale: dl }, listingAbs, opts.stores ?? ["chrome"], listingRel));
  // Stale strings (from .localizer/state.json).
  const stale = findStale({ root, manifest, localesDir, defaultLocale: dl }, source, listingRel, opts.stale ?? "warning");
  issues.push(...stale.issues);
  staleCheck = stale.check;
  return report();
}

export function formatIssue(i: Issue): string {
  const where = [i.locale ?? "manifest", i.key].filter(Boolean).join(" > ");
  return `${i.level === "error" ? "ERROR" : "warn "}  ${where}: ${i.message}`;
}

// ---------------------------------------------------------------------------
// File and line for each issue
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Fill in `file` (when not set) and `line` (when it can be found) for every issue. */
export function annotate(root: string, issues: Issue[], listingRel: string): void {
  const texts = new Map<string, string | null>();
  const read = (file: string): string | null => {
    if (!texts.has(file)) {
      try {
        texts.set(file, readFileSync(join(root, file), "utf8"));
      } catch {
        texts.set(file, null);
      }
    }
    return texts.get(file) ?? null;
  };
  for (const issue of issues) {
    const isListing = issue.key?.startsWith("listing.") || issue.message.startsWith("listing");
    if (!issue.file) {
      if (issue.locale === null) issue.file = manifestRel(root);
      else if (isListing) issue.file = `${listingRel}/${issue.locale}.json`;
      else issue.file = localeFileRel(root, issue.locale);
    }
    if (issue.line !== undefined) continue;
    const text = read(issue.file);
    if (text === null) continue;
    // JSON syntax errors: Node reports "(line N column M)" or "at position P".
    const lineMatch = /\(line (\d+) column \d+\)/.exec(issue.message);
    const posMatch = /at position (\d+)/.exec(issue.message);
    if (lineMatch) {
      issue.line = Number(lineMatch[1]);
      continue;
    }
    if (posMatch) {
      issue.line = lineAt(text, Number(posMatch[1]));
      continue;
    }
    if (!issue.key) continue;
    let re: RegExp;
    if (issue.file === manifestRel(root)) re = new RegExp(`__MSG_${escapeRegExp(issue.key)}__`, "i");
    else if (issue.key.startsWith("listing.")) re = new RegExp(`"${escapeRegExp(issue.key.slice(8))}"\\s*:`);
    else re = new RegExp(`^\\s*"${escapeRegExp(issue.key)}"\\s*:`, "im");
    const m = re.exec(text);
    if (m) issue.line = lineAt(text, m.index + (m[0].length - m[0].trimStart().length));
  }
}
