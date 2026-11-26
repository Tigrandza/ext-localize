import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChromeMessage, MessagesFile } from "./messages.ts";
import { writeJsonAtomic } from "./messages.ts";
import { localizerDir } from "./paths.ts";
import { placeholdersMatch } from "./placeholders.ts";
import { familyMember, pluralFamilies, splitPluralKey } from "./plurals.ts";

/**
 * .localizer/state.json — see README "State file format".
 *
 * {
 *   "version": 1,
 *   "sourceLocale": "en",
 *   "locales": {
 *     "de": {
 *       "messages": {
 *         "extName": { "sourceHash": "<sha256>", "targetHash": "<sha256>", "by": "deepl" }
 *       }
 *     }
 *   }
 * }
 *
 * Keys are sorted on write so the file diffs cleanly in git.
 */
export const STATE_VERSION = 1;
export const STATE_DIR = ".localizer";
export const STATE_FILE = "state.json";

export interface MessageState {
  /** sha256 of the source message (see hashSource). */
  sourceHash: string;
  /** sha256 of the translated message text as written. */
  targetHash: string;
  /** Who produced the text: "<provider>" or "<provider>/<model>", "adopted" or "manual". */
  by: string;
}

export interface LocaleState {
  /** _locales/<locale>/messages.json, per message key. */
  messages: Record<string, MessageState>;
  /** listing/<locale>.json, per field (name, summary, description). Optional, added in 0.2. */
  listing?: Record<string, MessageState>;
}

/** The part of a LocaleState that one translation job reads and writes. */
export type StateSection = "messages" | "listing";

export interface StateFile {
  version: number;
  sourceLocale: string;
  locales: Record<string, LocaleState>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Hash of what a translation depends on: the message text and the
 * placeholders block (names lower-cased, sorted). The description is NOT
 * part of the hash: editing a description does not force re-translation.
 */
export function hashSource(msg: ChromeMessage): string {
  const ph = msg.placeholders ?? {};
  const placeholders = Object.keys(ph)
    .map((name) => [name.toLowerCase(), ph[name]?.content ?? ""] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(JSON.stringify({ message: msg.message, placeholders }));
}

export function hashTarget(message: string): string {
  return sha256(message);
}

export function statePath(root: string): string {
  return join(localizerDir(root), STATE_FILE);
}

export function emptyState(sourceLocale: string): StateFile {
  return { version: STATE_VERSION, sourceLocale, locales: {} };
}

export function loadState(root: string, sourceLocale: string): StateFile {
  const path = statePath(root);
  if (!existsSync(path)) return emptyState(sourceLocale);
  const data = JSON.parse(readFileSync(path, "utf8")) as StateFile;
  if (data.version !== STATE_VERSION) {
    throw new Error(`${path}: unsupported state version ${data.version} (this tool writes version ${STATE_VERSION})`);
  }
  if (data.sourceLocale !== sourceLocale) {
    // The default locale changed: old hashes describe another language.
    return emptyState(sourceLocale);
  }
  data.locales ??= {};
  return data;
}

function sortObject<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k] as T;
  return out;
}

/** Write the state file. Returns false (and writes nothing) when the content is the same. */
export function saveState(root: string, state: StateFile): boolean {
  const locales: Record<string, LocaleState> = {};
  for (const [loc, ls] of Object.entries(sortObject(state.locales))) {
    const out: LocaleState = { messages: sortObject(ls.messages ?? {}) };
    if (ls.listing && Object.keys(ls.listing).length) out.listing = sortObject(ls.listing);
    locales[loc] = out;
  }
  const data = { version: STATE_VERSION, sourceLocale: state.sourceLocale, locales };
  const path = statePath(root);
  try {
    if (readFileSync(path, "utf8") === JSON.stringify(data, null, 2) + "\n") return false;
  } catch {
    // no file yet
  }
  writeJsonAtomic(path, data);
  return true;
}

// ---------------------------------------------------------------------------
// Diff planning
// ---------------------------------------------------------------------------

export type Reason = "new" | "changed" | "missing" | "invalid" | "forced";

export interface LocalePlan {
  locale: string;
  /** Keys to send to the translator, with why. */
  translate: { key: string; reason: Reason }[];
  /** Keys in the target file that are not in the source. */
  remove: string[];
  /** Keys whose translation is current. */
  keep: string[];
  /** Kept keys that had no state entry yet (first run on existing translations). */
  adopt: string[];
  /** Kept keys whose text was changed by hand since we wrote it. */
  manual: string[];
}

function findKey(data: Record<string, unknown>, key: string): string | undefined {
  if (key in data) return key;
  const lower = key.toLowerCase();
  return Object.keys(data).find((k) => k.toLowerCase() === lower);
}

/**
 * Decide what to do for one locale.
 *
 * - key missing in target                    -> translate ("new" if never seen, else "missing")
 * - target message broken (not a string, empty, placeholder set differs) -> translate ("invalid")
 * - state hash differs from current source   -> translate ("changed")
 * - no state entry but target has the key    -> keep and adopt (we never overwrite
 *                                               existing translations on the first run)
 * - otherwise                                -> keep
 * - --force                                  -> translate everything ("forced")
 */
export function planLocale(
  source: MessagesFile,
  target: Record<string, unknown> | null,
  localeState: Pick<LocaleState, "messages"> | undefined,
  locale: string,
  opts: { force?: boolean; checkFormat?: boolean } = {},
): LocalePlan {
  const plan: LocalePlan = { locale, translate: [], remove: [], keep: [], adopt: [], manual: [] };
  const tgt = target ?? {};
  const entries = localeState?.messages ?? {};
  const formatOk = (src: string, tgtMsg: string) => opts.checkFormat === false || placeholdersMatch(src, tgtMsg);
  // CLDR plural families: a locale only needs the categories its language uses.
  const families = pluralFamilies(Object.keys(source));

  for (const [key, src] of Object.entries(source)) {
    const entry = entries[key];
    const tKey = findKey(tgt, key);
    const tVal = tKey !== undefined ? (tgt[tKey] as { message?: unknown } | null) : undefined;
    const tMsg = tVal && typeof tVal === "object" && typeof tVal.message === "string" ? tVal.message : undefined;

    const member = familyMember(key, families, locale);
    if (member && !member.used && tKey === undefined) {
      continue; // e.g. items_one for Japanese: not needed, not written
    }
    if (opts.force) {
      plan.translate.push({ key, reason: "forced" });
    } else if (tKey === undefined) {
      plan.translate.push({ key, reason: entry ? "missing" : "new" });
    } else if (tMsg === undefined || tMsg.trim() === "" || !formatOk(src.message, tMsg)) {
      plan.translate.push({ key, reason: "invalid" });
    } else if (!entry) {
      plan.keep.push(key);
      plan.adopt.push(key);
    } else if (entry.sourceHash !== hashSource(src)) {
      plan.translate.push({ key, reason: "changed" });
    } else {
      plan.keep.push(key);
      if (entry.targetHash !== hashTarget(tMsg)) plan.manual.push(key);
    }
  }
  const sourceLower = new Set(Object.keys(source).map((k) => k.toLowerCase()));
  for (const key of Object.keys(tgt)) {
    // Extra keys of a plural family (items_few in Russian) belong to the locale: kept.
    if (!sourceLower.has(key.toLowerCase()) && !familyMember(key, families, locale)) plan.remove.push(key);
  }
  return plan;
}

/**
 * Build the new target file and the new locale state after translation.
 * `translated` holds only keys that passed validation. Keys that failed keep
 * their old text (if any) and their old state entry, so the next run retries.
 * Output key order follows the source file.
 */
export function applyPlan(
  source: MessagesFile,
  target: Record<string, unknown> | null,
  localeState: Pick<LocaleState, "messages"> | undefined,
  plan: LocalePlan,
  translated: Record<string, string>,
  by: string,
): { file: MessagesFile; state: Pick<LocaleState, "messages"> } {
  const tgt = target ?? {};
  const oldEntries = localeState?.messages ?? {};
  const file: MessagesFile = {};
  const messages: Record<string, MessageState> = {};
  const keep = new Set(plan.keep);
  const adopt = new Set(plan.adopt);
  const manual = new Set(plan.manual);
  const reasonOf = new Map(plan.translate.map((t) => [t.key, t.reason]));

  // Target keys of a source plural family that the source does not have (items_few):
  // written right after the last source key of their family.
  const families = pluralFamilies(Object.keys(source));
  const sourceLower = new Set(Object.keys(source).map((k) => k.toLowerCase()));
  const extras = new Map<string, string[]>();
  for (const k of Object.keys(tgt)) {
    const m = familyMember(k, families, plan.locale);
    if (m && !sourceLower.has(k.toLowerCase())) extras.set(m.base, [...(extras.get(m.base) ?? []), k]);
  }
  const lastOfFamily = new Map<string, string>();
  for (const k of Object.keys(source)) {
    const p = splitPluralKey(k);
    if (p && families.has(p.base)) lastOfFamily.set(p.base, k);
  }
  const addExtras = (key: string) => {
    const p = splitPluralKey(key);
    if (!p || lastOfFamily.get(p.base) !== key) return;
    for (const k of extras.get(p.base) ?? []) file[k] = tgt[k] as ChromeMessage;
  };

  for (const [key, src] of Object.entries(source)) {
    applyOne(key, src);
    addExtras(key);
  }
  return { file, state: { messages } };

  function applyOne(key: string, src: ChromeMessage): void {
    const sourceHash = hashSource(src);
    const newText = translated[key];
    if (newText !== undefined) {
      file[key] = buildEntry(src, newText);
      messages[key] = { sourceHash, targetHash: hashTarget(newText), by };
      return;
    }
    const tKey = findKey(tgt, key);
    const old = tKey !== undefined ? (tgt[tKey] as ChromeMessage) : undefined;
    const oldUsable = old && typeof old === "object" && typeof old.message === "string" && old.message.trim() !== "";
    if (keep.has(key) && old) {
      file[key] = old;
      if (adopt.has(key)) messages[key] = { sourceHash, targetHash: hashTarget(old.message), by: "adopted" };
      else if (manual.has(key)) messages[key] = { sourceHash, targetHash: hashTarget(old.message), by: "manual" };
      else if (oldEntries[key]) messages[key] = oldEntries[key];
    } else {
      // Failed this run: keep the old text if it is usable (a broken one is dropped,
      // so Chrome falls back to the default locale), keep the old state entry.
      if (oldUsable && reasonOf.get(key) !== "invalid") file[key] = old;
      if (oldEntries[key]) messages[key] = oldEntries[key];
    }
  }
}

function buildEntry(src: ChromeMessage, message: string): ChromeMessage {
  const entry: ChromeMessage = { message };
  if (src.description !== undefined) entry.description = src.description;
  if (src.placeholders !== undefined) entry.placeholders = src.placeholders;
  return entry;
}
