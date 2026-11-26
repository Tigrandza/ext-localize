import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Issue } from "./check.ts";
import { LISTING_FIELDS, listingPath, loadListing, readListingFile } from "./listing.ts";
import type { MessagesFile, Project } from "./messages.ts";
import { messagesPath, readMessagesFile } from "./messages.ts";
import { STATE_VERSION, hashSource, statePath, type LocaleState } from "./state.ts";
import { localeFileRel, relPath } from "./paths.ts";

/**
 * Stale strings: a locale has a translation for a key, but the source text (or
 * its placeholders) changed after that translation was made. Found by comparing
 * the sourceHash in .localizer/state.json with the hash of the current source.
 * This is the same comparison `translate` uses to plan "changed" keys.
 */
export const STALE_MODES = ["error", "warning", "off"] as const;
export type StaleMode = (typeof STALE_MODES)[number];

export type StaleStatus = "ok" | "off" | "no-state" | "bad-state" | "unknown-version" | "source-locale-changed" | "no-source";

export interface StaleCheck {
  mode: StaleMode;
  status: StaleStatus;
  /** Number of stale strings (same as the report's top-level "stale"). */
  stale: number;
  /** Translated keys with no state entry: never translated by the tool, so their age is unknown. */
  untracked: number;
  note: string;
}

function findKey(data: Record<string, unknown>, key: string): string | undefined {
  if (Object.hasOwn(data, key)) return key;
  const lower = key.toLowerCase();
  return Object.keys(data).find((k) => k.toLowerCase() === lower);
}

/**
 * Compute stale issues. `listingDirRel` is the listing folder relative to root.
 * Issues carry kind "stale" (one per stale string) or kind "state" (the state file
 * cannot be used).
 */
export function findStale(
  project: Pick<Project, "root" | "manifest" | "localesDir" | "defaultLocale">,
  source: Record<string, unknown>,
  listingDirRel: string,
  mode: StaleMode,
): { issues: Issue[]; check: StaleCheck } {
  const issues: Issue[] = [];
  const done = (status: StaleStatus, note: string, untracked = 0) => ({
    issues,
    check: { mode, status, stale: issues.filter((i) => i.kind === "stale").length, untracked, note },
  });
  if (mode === "off") return done("off", "Stale check is off (--stale=off).");
  const level = mode;
  const stateIssue = (message: string, lvl: Issue["level"] = level) =>
    issues.push({ level: lvl, kind: "state", locale: null, message, file: relPath(project.root, statePath(project.root)) });

  const path = statePath(project.root);
  if (!existsSync(path)) {
    return done("no-state", "No .localizer/state.json, so stale strings were not checked. Run translate once and commit the state file.");
  }
  let state: { version?: unknown; sourceLocale?: unknown; locales?: Record<string, LocaleState> };
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    const note = `.localizer/state.json does not parse (${(e as Error).message}), so stale strings could not be checked`;
    stateIssue(note);
    return done("bad-state", note);
  }
  if (!state || typeof state !== "object" || state.version !== STATE_VERSION) {
    const note = `.localizer/state.json has version ${JSON.stringify(state?.version)}; this tool knows version ${STATE_VERSION}, so stale strings could not be checked`;
    stateIssue(note);
    return done("unknown-version", note);
  }
  if (state.sourceLocale !== project.defaultLocale) {
    const note = `.localizer/state.json was made for source locale "${String(state.sourceLocale)}", but default_locale is "${project.defaultLocale}"; the next translate run resets it. Stale strings were not checked`;
    stateIssue(note, "warning");
    return done("source-locale-changed", note);
  }

  let untracked = 0;
  const locales = Object.keys(state.locales ?? {}).sort();

  // _locales messages
  const sourceHashes = new Map<string, string>();
  for (const [key, msg] of Object.entries(source)) {
    if (msg && typeof msg === "object" && typeof (msg as { message?: unknown }).message === "string") {
      sourceHashes.set(key, hashSource(msg as MessagesFile[string]));
    }
  }
  for (const locale of locales) {
    if (locale === project.defaultLocale) continue;
    const p = messagesPath(project.localesDir, locale);
    if (!existsSync(p)) continue;
    const r = readMessagesFile(p);
    if (!r.ok) continue; // reported by the other checks
    const entries = state.locales?.[locale]?.messages ?? {};
    for (const [key, hash] of sourceHashes) {
      const tKey = findKey(r.data, key);
      if (tKey === undefined) continue; // missing: reported by the other checks
      const tMsg = (r.data[tKey] as { message?: unknown } | null)?.message;
      if (typeof tMsg !== "string" || tMsg.trim() === "") continue;
      const entry = entries[key];
      if (!entry) {
        untracked++;
        continue;
      }
      if (entry.sourceHash !== hash) {
        issues.push({
          level,
          kind: "stale",
          locale,
          key,
          message: `source changed after translation (by ${entry.by}); run "ext-localize translate" to update`,
          file: localeFileRel(project.root, locale),
        });
      }
    }
  }

  // Store listing (only when the source listing loads)
  const dir = resolve(project.root, listingDirRel);
  if (existsSync(dir)) {
    let listingSource: Record<string, string> | null = null;
    try {
      listingSource = loadListing(project as Project, dir).source as Record<string, string>;
    } catch {
      listingSource = null; // reported by the listing checks
    }
    if (listingSource) {
      for (const locale of locales) {
        if (locale === project.defaultLocale) continue;
        const p = listingPath(dir, locale);
        if (!existsSync(p)) continue;
        const r = readListingFile(p);
        if (!r.ok) continue;
        const entries = state.locales?.[locale]?.listing ?? {};
        for (const field of LISTING_FIELDS) {
          const text = r.data[field];
          const src = listingSource[field];
          if (src === undefined || typeof text !== "string" || text.trim() === "") continue;
          const entry = entries[field];
          if (!entry) {
            untracked++;
            continue;
          }
          // Copied from _locales: always re-copied by translate --listing, so never "changed".
          // A stale copy shows up as the _locales message being stale, or as a sync warning.
          if (entry.by === "_locales") continue;
          if (entry.sourceHash !== hashSource({ message: src })) {
            issues.push({
              level,
              kind: "stale",
              locale,
              key: `listing.${field}`,
              message: `listing source changed after translation (by ${entry.by}); run "ext-localize translate --listing" to update`,
              file: relPath(project.root, listingPath(dir, locale)),
            });
          }
        }
      }
    }
  }
  const n = issues.filter((i) => i.kind === "stale").length;
  return done("ok", n ? `${n} translated string(s) are older than their source text.` : "No stale strings.", untracked);
}
