import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { relPath } from "./paths.ts";
import type { Issue } from "./check.ts";
import type { Store } from "./config.ts";
import { isChromeLocale } from "./locales.ts";
import type { MessagesFile, Project } from "./messages.ts";
import { listLocaleDirs, messagesPath, readMessagesFile, writeJsonAtomic } from "./messages.ts";
import type { TranslationJob } from "./translate.ts";

/**
 * Store listing pack: listing/<locale>.json = { "name", "summary", "description" }.
 *
 * The source is listing/<default_locale>.json. In the source only, "description"
 * may also be an array of lines (joined with "\n"), which is easier to edit and diff.
 * Translated files are always written with three plain strings.
 *
 * When manifest.json uses "__MSG_x__" for "name" (or "description"), the listing
 * name (or summary) is taken from _locales/<locale>/messages.json and never
 * translated on its own: that is what Chrome shows, so the stores stay in sync.
 */
export const LISTING_FIELDS = ["name", "summary", "description"] as const;
export type ListingField = (typeof LISTING_FIELDS)[number];
export type Listing = Partial<Record<ListingField, string>>;

/** Character limits per store (code points). Edge: only the description is typed per language. */
export const STORE_LIMITS: Record<Store, Partial<Record<ListingField, number>>> = {
  // name 75 and summary 132 are the manifest limits; 16,000 is the dashboard textarea maxlength.
  chrome: { name: 75, summary: 132, description: 16000 },
  // addons-server Addon model (name 50, summary 250, description 15000); the API returns 400 above them.
  firefox: { name: 50, summary: 250, description: 15000 },
  // Partner Center: "Minimum 250 characters, maximum 10,000 characters" for the description.
  edge: { description: 10000 },
};
export const EDGE_DESCRIPTION_MIN = 250;

export const STORE_LABEL: Record<Store, string> = {
  chrome: "Chrome Web Store",
  firefox: "Firefox Add-ons (AMO)",
  edge: "Edge Add-ons",
};

const FIELD_CONTEXT: Record<ListingField, string> = {
  name: "Extension name in the store listing.",
  summary: "Short summary shown under the name in the store listing.",
  description: "Long description on the store page. Keep paragraphs, line breaks and list markers.",
};

/** Manifest field that feeds each listing field when it uses __MSG_x__. */
const MANIFEST_FIELD: Partial<Record<ListingField, string>> = { name: "name", summary: "description" };

/**
 * The listing folder. A relative `dir` is resolved from `base` (the extension
 * folder by default); an absolute one is used as is.
 */
export function listingDir(root: string, dir = "listing", base: string = root): string {
  return resolve(base, dir);
}

export function listingPath(dir: string, locale: string): string {
  return join(dir, `${locale}.json`);
}

export const codePoints = (s: string): number => [...s].length;

export type ListingRead =
  | { ok: true; data: Listing; problems: string[]; unknownKeys: string[] }
  | { ok: false; error: string };

/**
 * Read one listing file. `allowLines`: description may be an array of strings
 * (source file only). Problems are shape errors that make a field unusable.
 */
export function readListingFile(path: string, allowLines = false): ListingRead {
  let raw: unknown;
  try {
    let text = readFileSync(path, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "top level must be a JSON object" };
  const obj = raw as Record<string, unknown>;
  const data: Listing = {};
  const problems: string[] = [];
  for (const field of LISTING_FIELDS) {
    const v = obj[field];
    if (v === undefined) continue;
    if (typeof v === "string") data[field] = v;
    else if (field === "description" && allowLines && Array.isArray(v) && v.every((x) => typeof x === "string")) data[field] = v.join("\n");
    else problems.push(`"${field}" must be a string${field === "description" && allowLines ? " or an array of lines" : ""}`);
  }
  const unknownKeys = Object.keys(obj).filter((k) => !(LISTING_FIELDS as readonly string[]).includes(k));
  return { ok: true, data, problems, unknownKeys };
}

/** Locales that have a listing file (by file name, valid Chrome codes only). */
export function listListingLocales(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"))
    .filter(isChromeLocale)
    .sort();
}

/** "__MSG_extName__" -> "extName", else null. */
export function msgRef(value: unknown): string | null {
  const m = typeof value === "string" ? /^__MSG_([A-Za-z0-9_@]+)__$/.exec(value) : null;
  return m ? (m[1] as string) : null;
}

/** Message text as shown to users: "$$" is a literal "$". */
function shownText(message: string): string {
  return message.replace(/\$\$/g, "$");
}

/** Look up a message (case-insensitive key) in _locales/<locale>; undefined if the file or key is missing. */
export function localeMessage(project: Pick<Project, "localesDir">, locale: string, key: string): string | undefined {
  const path = messagesPath(project.localesDir, locale);
  if (!existsSync(path)) return undefined;
  const r = readMessagesFile(path);
  if (!r.ok) return undefined;
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(r.data)) {
    const m = (v as { message?: unknown } | null)?.message;
    if (k.toLowerCase() === lower && typeof m === "string" && m.trim() !== "") return shownText(m);
  }
  return undefined;
}

/** Listing fields that come from _locales: field -> message key. */
export function syncedFields(project: Pick<Project, "manifest">): Partial<Record<ListingField, string>> {
  const out: Partial<Record<ListingField, string>> = {};
  for (const [field, mf] of Object.entries(MANIFEST_FIELD) as [ListingField, string][]) {
    const ref = msgRef(project.manifest[mf]);
    if (ref) out[field] = ref;
  }
  return out;
}

export class ListingError extends Error {}

export interface ListingProject {
  dir: string;
  sourceLocale: string;
  /** Effective source listing (synced fields filled from _locales). */
  source: Listing;
  synced: Partial<Record<ListingField, string>>;
}

/**
 * Load the source listing. Throws ListingError with a fixable message.
 * A synced field may be left out of the source file; it is read from _locales.
 */
export function loadListing(project: Project, dir: string): ListingProject {
  const sourcePath = listingPath(dir, project.defaultLocale);
  if (!existsSync(sourcePath)) {
    throw new ListingError(
      `No source listing: ${sourcePath} is missing. Create it with "name", "summary" and "description" (see README, "Store listing").`,
    );
  }
  const r = readListingFile(sourcePath, true);
  if (!r.ok) throw new ListingError(`${sourcePath}: ${r.error}`);
  if (r.problems.length) throw new ListingError(`${sourcePath}: ${r.problems.join("; ")}`);
  const synced = syncedFields(project);
  const source: Listing = { ...r.data };
  for (const [field, key] of Object.entries(synced) as [ListingField, string][]) {
    if (source[field] === undefined) {
      const text = localeMessage(project, project.defaultLocale, key);
      if (text !== undefined) source[field] = text;
    }
  }
  for (const field of LISTING_FIELDS) {
    if (source[field] === undefined || source[field].trim() === "") {
      throw new ListingError(`${sourcePath}: "${field}" is missing or empty`);
    }
  }
  return { dir, sourceLocale: project.defaultLocale, source, synced };
}

/** The tightest limit per field over the given stores. */
export function limitsFor(stores: readonly Store[]): Partial<Record<ListingField, number>> {
  const out: Partial<Record<ListingField, number>> = {};
  for (const store of stores) {
    for (const [field, max] of Object.entries(STORE_LIMITS[store]) as [ListingField, number][]) {
      out[field] = Math.min(out[field] ?? Infinity, max);
    }
  }
  return out;
}

function toMessages(listing: Listing): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of LISTING_FIELDS) if (listing[field] !== undefined) out[field] = { message: listing[field] };
  return out;
}

/** Translation job for the listing. Name and summary are copied from _locales where the manifest uses __MSG_. */
export function listingJob(project: Project, lp: ListingProject, stores: readonly Store[]): TranslationJob {
  const source: MessagesFile = {};
  for (const field of LISTING_FIELDS) {
    source[field] = { message: lp.source[field] as string, description: FIELD_CONTEXT[field] };
  }
  const maxLength = limitsFor(stores);
  return {
    kind: "listing",
    root: project.root,
    sourceLocale: lp.sourceLocale,
    source,
    section: "listing",
    formatTokens: false,
    maxLength: maxLength as Record<string, number>,
    read(locale) {
      const path = listingPath(lp.dir, locale);
      if (!existsSync(path)) return { ok: true, data: null };
      const r = readListingFile(path);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, data: toMessages(r.data) };
    },
    write(locale, file) {
      const out: Listing = {};
      for (const field of LISTING_FIELDS) {
        const m = file[field]?.message;
        if (m !== undefined) out[field] = m;
      }
      writeJsonAtomic(listingPath(lp.dir, locale), out);
    },
    fileFor: (locale) => relPath(project.root, listingPath(lp.dir, locale)),
    fixed(locale) {
      const out: Record<string, string> = {};
      for (const [field, key] of Object.entries(lp.synced) as [ListingField, string][]) {
        const text = localeMessage(project, locale, key);
        if (text !== undefined) out[field] = text;
      }
      return out;
    },
  };
}

/** Default listing targets: existing _locales folders and existing listing files. */
export function defaultListingTargets(project: Project, dir: string): string[] {
  const set = new Set([...listLocaleDirs(project.localesDir).filter(isChromeLocale), ...listListingLocales(dir)]);
  set.delete(project.defaultLocale);
  return [...set].sort();
}

/** Read every listing file (source first rules: description lines allowed only in the source). */
export function readAllListings(dir: string, sourceLocale: string): Record<string, Listing> {
  const out: Record<string, Listing> = {};
  for (const locale of listListingLocales(dir)) {
    const r = readListingFile(listingPath(dir, locale), locale === sourceLocale);
    if (!r.ok) throw new ListingError(`${listingPath(dir, locale)}: ${r.error}`);
    if (r.problems.length) throw new ListingError(`${listingPath(dir, locale)}: ${r.problems.join("; ")}`);
    out[locale] = r.data;
  }
  return out;
}

/**
 * Listing checks for `check`. Returns [] when the listing folder does not exist,
 * so projects without a listing get the same report as before.
 */
export function checkListing(
  project: Pick<Project, "manifest" | "localesDir" | "defaultLocale">,
  dir: string,
  stores: readonly Store[],
  /** How to show the folder in messages, for example "../store/listing". */
  shown = "listing",
): Issue[] {
  if (!existsSync(dir)) return [];
  const issues: Issue[] = [];
  const add = (level: Issue["level"], locale: string | null, key: string | undefined, message: string) =>
    issues.push(key ? { level, locale, key, message } : { level, locale, message });

  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const sourceFile = `${project.defaultLocale}.json`;
  if (!files.includes(sourceFile)) add("error", project.defaultLocale, undefined, `listing: no source file ${shown}/${sourceFile}`);
  const synced = syncedFields(project);

  for (const file of files) {
    const locale = basename(file, ".json");
    if (!isChromeLocale(locale)) {
      add("error", locale, undefined, `listing: file name "${file}" is not a Chrome locale code (for example de.json, pt_BR.json)`);
      continue;
    }
    const isSource = locale === project.defaultLocale;
    const r = readListingFile(join(dir, file), isSource);
    if (!r.ok) {
      add("error", locale, undefined, `listing: ${shown}/${file}: ${r.error}`);
      continue;
    }
    for (const p of r.problems) add("error", locale, undefined, `listing: ${shown}/${file}: ${p}`);
    for (const k of r.unknownKeys) add("warning", locale, `listing.${k}`, `listing: unknown field "${k}" (only name, summary, description are used)`);
    const data = { ...r.data };

    for (const field of LISTING_FIELDS) {
      const key = `listing.${field}`;
      let value = data[field];
      const msgKey = synced[field];
      const fromLocales = msgKey ? localeMessage(project, locale, msgKey) : undefined;
      if (msgKey && fromLocales !== undefined && value !== undefined && value !== fromLocales) {
        add(
          "warning",
          locale,
          key,
          `listing ${field} "${short(value)}" differs from _locales/${locale} ${msgKey} "${short(fromLocales)}"; run "ext-localize translate --listing" to sync`,
        );
      }
      if (value === undefined && isSource && fromLocales !== undefined) value = fromLocales;
      if (value === undefined) {
        if (isSource || !(msgKey && fromLocales !== undefined)) add("error", locale, key, `listing: "${field}" is missing`);
        continue;
      }
      if (value.trim() === "") {
        add("error", locale, key, `listing: "${field}" is empty`);
        continue;
      }
      const len = codePoints(value);
      for (const store of stores) {
        const max = STORE_LIMITS[store][field];
        if (max !== undefined && len > max) add("error", locale, key, `listing ${field} is ${len} characters; ${STORE_LABEL[store]} limit is ${max}`);
      }
      if (field === "description" && stores.includes("edge") && len < EDGE_DESCRIPTION_MIN) {
        add("warning", locale, key, `listing description is ${len} characters; Edge Add-ons needs at least ${EDGE_DESCRIPTION_MIN}`);
      }
      if (stores.includes("firefox")) {
        if (field === "description" && /^#{1,6}\s/m.test(value)) {
          add("warning", locale, key, `listing description has "#" heading lines; AMO drops Markdown headings`);
        }
        if (field === "summary" && /https?:\/\/|www\./i.test(value)) {
          add("warning", locale, key, `listing summary has a URL; AMO does not allow URLs in the summary`);
        }
      }
    }
  }
  return issues;
}

function short(s: string): string {
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}
