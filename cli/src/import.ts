import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { UsageError } from "./usage.ts";
import type { Listing } from "./listing.ts";
import { LISTING_FIELDS, listingPath, localeMessage, readListingFile, syncedFields } from "./listing.ts";
import { normalizeLocale } from "./locales.ts";
import type { Project } from "./messages.ts";
import { writeJsonAtomic } from "./messages.ts";

export interface ImportRow {
  locale: string;
  action: "written" | "skipped";
  note?: string;
}

/**
 * Find description files. `pattern` is a folder (files named <locale>.txt) or a
 * path whose file name contains "{locale}", for example store/descriptions/{locale}.txt.
 * Locale codes in file names are normalized (pt-BR -> pt_BR).
 */
export function findDescriptionFiles(pattern: string): { locale: string | null; raw: string; path: string }[] {
  let dir: string;
  let re: RegExp;
  if (pattern.includes("{locale}")) {
    dir = dirname(pattern);
    const name = basename(pattern);
    if (dir.includes("{locale}")) throw new UsageError(`"{locale}" may only appear in the file name: ${pattern}`);
    const [before, after] = name.split("{locale}") as [string, string];
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`^${esc(before)}([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?)${esc(after)}$`);
  } else {
    dir = pattern;
    re = /^([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?)\.txt$/;
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new UsageError(`folder not found: ${dir}`);
  const out: { locale: string | null; raw: string; path: string }[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = re.exec(f);
    if (m) out.push({ locale: normalizeLocale(m[1] as string), raw: m[1] as string, path: join(dir, f) });
  }
  return out;
}

/** Write listing/<locale>.json from description files. Existing files are kept unless force. */
export function importDescriptions(project: Project, listingDirAbs: string, pattern: string, opts: { force?: boolean } = {}): ImportRow[] {
  const files = findDescriptionFiles(pattern);
  if (!files.length) throw new UsageError(`no description files found for ${pattern}`);
  const synced = syncedFields(project);
  const rows: ImportRow[] = [];
  for (const f of files) {
    if (!f.locale) {
      rows.push({ locale: f.raw, action: "skipped", note: "not a Chrome locale code" });
      continue;
    }
    const target = listingPath(listingDirAbs, f.locale);
    let existing: Listing = {};
    if (existsSync(target)) {
      if (!opts.force) {
        rows.push({ locale: f.locale, action: "skipped", note: `${basename(target)} exists (use --force to overwrite)` });
        continue;
      }
      const r = readListingFile(target, f.locale === project.defaultLocale);
      if (r.ok) existing = r.data;
    }
    let text = readFileSync(f.path, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    if (!text.trim()) {
      rows.push({ locale: f.locale, action: "skipped", note: "empty file" });
      continue;
    }
    const out: Listing = {};
    const notes: string[] = [];
    for (const field of LISTING_FIELDS) {
      if (field === "description") {
        out.description = text;
        continue;
      }
      const key = synced[field];
      const fromLocales = key ? localeMessage(project, f.locale, key) : undefined;
      if (fromLocales !== undefined) out[field] = fromLocales;
      else if (existing[field] !== undefined) out[field] = existing[field];
      else notes.push(`no ${field}`);
    }
    writeJsonAtomic(target, out);
    rows.push({ locale: f.locale, action: "written", note: notes.length ? `${notes.join(", ")}: add it by hand or run translate --listing` : undefined });
  }
  return rows;
}
