import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Listing } from "../listing.ts";
import { EDGE_DESCRIPTION_MIN, STORE_LIMITS, codePoints } from "../listing.ts";

/**
 * Microsoft Edge Add-ons: there is no API for listing text. The Edge Add-ons
 * REST API only uploads and publishes packages; the docs say metadata such as
 * the description must be edited in Partner Center.
 *
 * In Partner Center the extension name and short description are read from the
 * package manifest (_locales). Only the Description (250 to 10,000 characters)
 * and optional search terms are typed per language. So this command writes one
 * text file per locale with the description, ready to copy.
 * Source: https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension
 */
export const EDGE_DESCRIPTION_MAX = STORE_LIMITS.edge.description as number;

export interface EdgeEntry {
  /** Chrome locale of the listing file. */
  locale: string;
  /** Description length in characters. */
  length: number;
  problem?: string;
  file?: string;
}

/** Write <dir>/<locale>.txt per listing; return what was written and what has problems. */
export function writeEdgeFiles(listings: Record<string, Listing>, dir: string): EdgeEntry[] {
  mkdirSync(dir, { recursive: true });
  const out: EdgeEntry[] = [];
  for (const locale of Object.keys(listings).sort()) {
    const d = listings[locale]?.description ?? "";
    const length = codePoints(d);
    const entry: EdgeEntry = { locale, length };
    if (d.trim() === "") entry.problem = "no description";
    else if (length < EDGE_DESCRIPTION_MIN) entry.problem = `too short: Partner Center needs at least ${EDGE_DESCRIPTION_MIN} characters`;
    else if (length > EDGE_DESCRIPTION_MAX) entry.problem = `too long: Partner Center allows at most ${EDGE_DESCRIPTION_MAX} characters`;
    if (d.trim() !== "") {
      const file = join(dir, `${locale}.txt`);
      writeFileSync(file, d.endsWith("\n") ? d : d + "\n");
      entry.file = file;
    }
    out.push(entry);
  }
  return out;
}

/** Copy-ready block for one locale. */
export function edgeBlock(locale: string, listing: Listing): string {
  const line = "=".repeat(60);
  return `${line}\n${locale} - Description (${codePoints(listing.description ?? "")} characters)\n${line}\n${listing.description ?? ""}\n`;
}
