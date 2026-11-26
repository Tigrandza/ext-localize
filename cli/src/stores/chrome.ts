import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Listing } from "../listing.ts";
import { codePoints } from "../listing.ts";
import { localizerDir } from "../paths.ts";

/**
 * Chrome Web Store listing delivery.
 *
 * Chrome has no API for listing text. Name and summary come from the manifest
 * (_locales). Only the "Detailed description" is typed per language in the
 * dashboard. Default delivery: one script the developer pastes into DevTools on
 * the Store listing tab; it fills every language, and the developer clicks
 * "Save draft". The script never clicks Submit or Publish.
 */

/** Dashboard textarea maxlength (seen on the real dashboard; not in Google docs). */
export const CHROME_DESCRIPTION_MAX = 16000;

export const DASHBOARD_URL = "https://chrome.google.com/webstore/devconsole/";

/** fill-core.js ships in assets/ next to src/ and dist/. */
export function fillCorePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "assets", "fill-core.js");
}

export function readFillCore(): string {
  return readFileSync(fillCorePath(), "utf8");
}

export type FillMode = "fill-all" | "save-each";

export interface Descriptions {
  /**
   * Chrome locale -> description, plus its length in code points and a short
   * SHA-256 hash, computed here from the listing file. The page script refuses to
   * fill when the embedded text no longer matches them.
   */
  [locale: string]: { description: string; length?: number; sha?: string };
}

/** First 12 hex digits of SHA-256 over the UTF-8 text (same as fill-core's shortHash). */
export function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/**
 * JSON with every non-ASCII character written as a \uXXXX escape (astral
 * characters as surrogate pairs). The result is pure ASCII, so no clipboard or
 * encoding step between the file and the console can change it.
 */
export function asciiJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function isAscii(text: string): boolean {
  return /^[\x00-\x7f]*$/.test(text);
}

/** Pick the descriptions to fill; report the ones that cannot be used. */
export function chromeDescriptions(listings: Record<string, Listing>): { descriptions: Descriptions; problems: string[] } {
  const descriptions: Descriptions = {};
  const problems: string[] = [];
  for (const locale of Object.keys(listings).sort()) {
    const d = listings[locale]?.description;
    if (d === undefined || d.trim() === "") {
      problems.push(`${locale}: no description`);
      continue;
    }
    if (codePoints(d) > CHROME_DESCRIPTION_MAX) {
      problems.push(`${locale}: description is ${codePoints(d)} characters; the dashboard limit is ${CHROME_DESCRIPTION_MAX}`);
      continue;
    }
    // The page normalizes line endings the same way before comparing.
    const text = d.replace(/\r\n/g, "\n");
    descriptions[locale] = { description: text, length: codePoints(text), sha: shortHash(text) };
  }
  return { descriptions, problems };
}

/**
 * Build the paste script. Plain concatenation (no templates over fill-core,
 * which contains "$" and backticks of its own).
 */
export function buildPasteScript(descriptions: Descriptions, opts: { mode?: FillMode; core?: string } = {}): string {
  const script = buildPasteScriptRaw(descriptions, opts);
  if (!isAscii(script)) throw new Error("internal error: the paste script is not pure ASCII");
  return script;
}

function buildPasteScriptRaw(descriptions: Descriptions, opts: { mode?: FillMode; core?: string }): string {
  const mode = opts.mode ?? "fill-all";
  const save = mode === "save-each" ? "wait" : "none";
  const core = opts.core ?? readFillCore();
  const locales = Object.keys(descriptions);
  return [
    "// ext-localize: paste into the DevTools console on the Chrome Web Store \"Store listing\" tab.",
    `// Fills the detailed description for ${locales.length} language(s): ${locales.join(", ")}.`,
    "// It never clicks Submit for review or Publish. Check the text, then click \"Save draft\" yourself.",
    `// mode=${mode}`,
    "(async () => {",
    core,
    "const LISTINGS = " + asciiJson(descriptions, 2) + ";",
    "window.__listingFillReport = await globalThis.ListingFill.run(LISTINGS, { mode: " +
      JSON.stringify(mode) +
      ", save: " +
      JSON.stringify(save) +
      " });",
    "})();",
    "",
  ].join("\n");
}

/** Read-only script: finds the elements and lists the dashboard languages. Changes nothing. */
export function buildDiagnoseScript(locales: string[], opts: { core?: string } = {}): string {
  const core = opts.core ?? readFillCore();
  const script = [
    "// ext-localize: DIAGNOSE (read-only). Paste on the Store listing tab. Changes nothing, saves nothing.",
    "(async () => {",
    core,
    "const L = globalThis.ListingFill, out = { url: location.href, version: L.VERSION };",
    "const tryIt = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = 'ERROR: ' + e.message; } };",
    "tryIt('textarea', () => { const t = L.findTextarea(); return { foundBy: t.how, maxlength: t.el.getAttribute('maxlength'), length: t.el.value.length }; });",
    "try { out.languages = await L.listDashboardLanguages(); } catch (e) { out.languages = 'ERROR: ' + e.message; }",
    "out.localeFiles = " + asciiJson(locales) + ".map((l) => ({ locale: l, dashboardCode: L.toDashboardCode(l) }));",
    "console.log('[listing-fill] DIAGNOSE', JSON.stringify(out, null, 2));",
    "window.__listingFillDiagnose = out;",
    "})();",
    "",
  ].join("\n");
  if (!isAscii(script)) throw new Error("internal error: the diagnose script is not pure ASCII");
  return script;
}

/** Output folder for generated files. It gets its own .gitignore. */
export function outDir(root: string): string {
  const dir = join(localizerDir(root), "out");
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "# Generated by ext-localize. Not meant for git.\n*\n");
  return dir;
}

type Run = (cmd: string, opts: { input?: string; env: NodeJS.ProcessEnv }) => { status: number | null; stdout?: string | Buffer; error?: Error };

// maxBuffer: scripts with non-Latin text can pass 1 MB (the spawnSync default limit).
export const defaultRun: Run = (cmd, opts) => spawnSync(cmd, { input: opts.input, env: opts.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Copy text to the macOS clipboard, then read it back and compare.
 * pbcopy decodes its input with the current locale; with no LANG/LC_* set it
 * reads UTF-8 as MacRoman. So both commands run with LC_ALL=en_US.UTF-8.
 * Returns an error message, or null when the clipboard holds exactly `text`.
 */
export function copyToClipboard(text: string, run: Run = defaultRun, platform: string = process.platform): string | null {
  if (platform !== "darwin") return "copying is only supported on macOS (pbcopy); open the file instead";
  const env = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
  const w = run("pbcopy", { input: text, env });
  if (w.error) return `pbcopy failed: ${w.error.message}`;
  if (w.status !== 0) return `pbcopy exited with ${w.status}`;
  const r = run("pbpaste", { env });
  if (r.error) return `pbpaste failed: ${r.error.message}`;
  if (r.status !== 0) return `pbpaste exited with ${r.status}`;
  const back = String(r.stdout ?? "");
  if (back !== text) {
    return `the clipboard does not hold the script (read back ${back.length} characters, expected ${text.length}). Do not paste it; open the file and copy it by hand`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Guards shared with --auto
// ---------------------------------------------------------------------------

const DASHBOARD_HOSTS = new Set(["chrome.google.com", "chromewebstore.google.com"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Item id of a dashboard URL, or null. Only the dashboard hosts count (and
 * local pages, used by the tests with a mock dashboard).
 * Example: https://chrome.google.com/webstore/devconsole/<publisher>/<item>/edit
 */
export function itemFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!DASHBOARD_HOSTS.has(u.hostname) && !LOCAL_HOSTS.has(u.hostname)) return null;
  const m = /\/devconsole\/[^/]+\/([a-p]{32})(?:\/|$)/.exec(u.pathname);
  return m ? (m[1] as string) : null;
}

export function isItemId(id: string): boolean {
  return /^[a-p]{32}$/.test(id);
}

/**
 * Decide whether --auto may click "Save draft".
 * - --item is always required, and the open tab must be that item.
 * - Saving is allowed on items listed in chrome.testItems (config). Any other
 *   item may be live, so it also needs --allow-live.
 */
export function checkSaveAllowed(
  tabItem: string | null,
  a: { item?: string; save?: boolean; allowLive?: boolean; testItems?: readonly string[] },
): void {
  if (!a.item) throw new Error("Refusing: pass --item <itemId> so only the item you named is touched.");
  if (tabItem !== a.item) throw new Error(`Refusing: the open tab is item ${tabItem ?? "(none)"}, not --item ${a.item}.`);
  if (a.save && !(a.testItems ?? []).includes(a.item) && !a.allowLive) {
    throw new Error(
      `Refusing to save: ${a.item} is not in chrome.testItems in .localizer/config.json, so it may be a live item. ` +
        `Use a test item, or pass --allow-live after you decide to.`,
    );
  }
}
