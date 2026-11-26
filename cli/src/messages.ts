import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localeFileRel, localesDirFor, localesRel, manifestPathFor, manifestRel } from "./paths.ts";

export interface PlaceholderDef {
  content: string;
  example?: string;
}

export interface ChromeMessage {
  message: string;
  description?: string;
  placeholders?: Record<string, PlaceholderDef>;
}

/** Contents of one _locales/<locale>/messages.json. Key order is kept. */
export type MessagesFile = Record<string, ChromeMessage>;

export type ReadResult =
  | { ok: true; data: Record<string, unknown>; hadBom: boolean }
  | { ok: false; error: string };

/** Read and strictly parse a messages.json. Chrome drops a locale whose file does not parse. */
export function readMessagesFile(path: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, error: `cannot read file: ${(e as Error).message}` };
  }
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) text = text.slice(1);
  try {
    const data: unknown = JSON.parse(text);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "top level must be a JSON object" };
    }
    return { ok: true, data: data as Record<string, unknown>, hadBom };
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
}

/** Write JSON atomically (temp file + rename), 2-space indent, trailing newline. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Remove // and /* *\/ comments outside of strings. Chrome accepts comments in
 * manifest.json, so a strict JSON.parse would fail on some real manifests.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out;
}

export interface Project {
  root: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  defaultLocale: string;
  localesDir: string;
  sourcePath: string;
  source: MessagesFile;
}

export class ProjectError extends Error {}

export function messagesPath(localesDir: string, locale: string): string {
  return join(localesDir, locale, "messages.json");
}

/** Locale folder names that exist under _locales/ (any name, valid or not). */
export function listLocaleDirs(localesDir: string): string[] {
  if (!existsSync(localesDir)) return [];
  return readdirSync(localesDir)
    .filter((name) => !name.startsWith(".") && statSync(join(localesDir, name)).isDirectory())
    .sort();
}

/**
 * Read manifest.json and the default locale's messages.json.
 * Throws ProjectError with a short, fixable message on any problem.
 */
export function loadProject(root: string): Project {
  const manifestPath = manifestPathFor(root);
  if (!existsSync(manifestPath)) {
    throw new ProjectError(
      manifestRel(root) === "manifest.json"
        ? `No manifest.json in ${root}. Use --dir to point at the extension folder, or --manifest to point at a manifest file.`
        : `Manifest not found: ${manifestPath}`,
    );
  }
  let manifest: Record<string, unknown>;
  try {
    let raw = readFileSync(manifestPath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    manifest = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
  } catch (e) {
    throw new ProjectError(`${manifestRel(root)} does not parse: ${(e as Error).message}`);
  }
  const localesDir = localesDirFor(root);
  const defaultLocale = manifest["default_locale"];
  if (typeof defaultLocale !== "string" || !defaultLocale) {
    throw new ProjectError(
      existsSync(localesDir)
        ? `manifest.json has no "default_locale", but ${localesRel(root)}/ exists. Chrome will refuse to load the extension.`
        : `manifest.json has no "default_locale". Add it (for example "en") and create ${localesRel(root)}/en/messages.json.`,
    );
  }
  const sourcePath = messagesPath(localesDir, defaultLocale);
  const read = readMessagesFile(sourcePath);
  if (!read.ok) throw new ProjectError(`Source file ${localeFileRel(root, defaultLocale)}: ${read.error}`);
  const source: MessagesFile = {};
  for (const [key, value] of Object.entries(read.data)) {
    if (!value || typeof value !== "object" || typeof (value as ChromeMessage).message !== "string") {
      throw new ProjectError(`Source key "${key}" has no "message" string.`);
    }
    source[key] = value as ChromeMessage;
  }
  return { root, manifestPath, manifest, defaultLocale, localesDir, sourcePath, source };
}
