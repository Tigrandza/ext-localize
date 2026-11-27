import { existsSync, readFileSync } from "node:fs";
import type { CheckReport, Issue } from "./check.ts";
import { ConfigError } from "./config.ts";
import { listListingLocales } from "./listing.ts";
import { isChromeLocale } from "./locales.ts";

/**
 * Read the file names of a .zip (the package you upload to the store) from its
 * central directory. No extraction, no dependency. ZIP64 archives are not supported.
 */
export function zipEntries(path: string): string[] {
  if (!existsSync(path)) throw new ConfigError(`zip file not found: ${path}`);
  const buf = readFileSync(path);
  // End of central directory record: signature 0x06054b50, at most 65,535 + 22 bytes from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ConfigError(`${path} is not a zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  const offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) throw new ConfigError(`${path}: ZIP64 archives are not supported`);
  const names: string[] = [];
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ConfigError(`${path}: damaged zip central directory`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** Locale folders with a messages.json inside the package (at the root, or under one top folder). */
export function zipLocales(path: string): string[] {
  const out = new Set<string>();
  for (const name of zipEntries(path)) {
    const m = /^(?:[^/]+\/)?_locales\/([^/]+)\/messages\.json$/.exec(name);
    if (m) out.add(m[1] as string);
  }
  return [...out].sort();
}

/**
 * Compare listing files with the package's _locales. The dashboard offers a
 * language only when the uploaded package has that locale folder.
 */
export function zipIssues(zipPath: string, listingDirAbs: string, listingRel: string, defaultLocale: string | null): Issue[] {
  const inZip = new Set(zipLocales(zipPath));
  // No listing folder: the project does not manage its listing with this tool, so
  // there is nothing to compare (same rule as "check": no listing/, no listing issues).
  if (!existsSync(listingDirAbs)) return [];
  const listing = listListingLocales(listingDirAbs);
  const issues: Issue[] = [];
  for (const locale of listing) {
    if (!inZip.has(locale)) {
      issues.push({
        level: "warning",
        locale,
        key: "listing.description",
        message: `listing: the package ${zipPath} has no _locales/${locale}, so the dashboard will not offer this language`,
        file: `${listingRel}/${locale}.json`,
      });
    }
  }
  for (const locale of inZip) {
    // nb and other names the store does not list cannot have a listing file: skip them.
    if (locale !== defaultLocale && isChromeLocale(locale) && !listing.includes(locale)) {
      issues.push({
        level: "warning",
        locale,
        key: "listing.description",
        message: `listing: the package has _locales/${locale} but there is no ${listingRel}/${locale}.json, so its store description stays empty`,
        file: `${listingRel}/${locale}.json`,
      });
    }
  }
  return issues;
}

/** Recompute the counts after issues were added. */
export function recount(report: CheckReport): void {
  report.errors = report.issues.filter((i) => i.level === "error").length;
  report.warnings = report.issues.filter((i) => i.level === "warning").length;
  report.stale = report.issues.filter((i) => i.kind === "stale").length;
}
