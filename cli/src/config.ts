import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FORMALITIES, type Formality } from "./providers/types.ts";
import { localizerDir } from "./paths.ts";

/**
 * Optional project config: .localizer/config.json. Command-line flags win over it.
 *
 * {
 *   "provider": "deepl",
 *   "model": "claude-opus-5-5",
 *   "effort": "medium",
 *   "formality": "prefer_more",
 *   "to": "de,fr,pt-BR",                 // or "all", or ["de", "fr"]
 *   "glossary": ".localizer/glossary.json",
 *   "stores": ["chrome", "firefox"],     // whose listing limits `check` enforces
 *   "listing": { "dir": "listing" },
 *   "manifest": "manifest.json",           // a manifest file outside the extension folder
 *   "locales": { "dir": "public/_locales" },  // _locales outside the extension folder (WXT, Plasmo)
 *   "check": { "ignoreKeys": ["appShortName", "*_zero"], "missingKeys": "warning" },
 *   "firefox": { "addon": "my-addon", "defaultLocale": "en-US", "extraLocales": [], "host": "https://addons.mozilla.org" },
 *   "chrome": { "item": "<32-letter id>", "publisher": "<uuid>", "testItems": ["<id>"], "browser": "launch", "profile": "~/.ext-localize/chrome-profile" }
 * }
 *
 * Unknown keys are an error, so a typo does not silently do nothing.
 */
export const STORES = ["chrome", "firefox", "edge"] as const;
export type Store = (typeof STORES)[number];

export interface Config {
  provider?: string;
  model?: string;
  effort?: string;
  formality?: Formality;
  to?: string;
  glossary?: string;
  stores?: Store[];
  listing?: { dir?: string };
  manifest?: string;
  locales?: { dir?: string };
  check?: { ignoreKeys?: string[]; missingKeys?: "error" | "warning" };
  firefox?: { addon?: string; defaultLocale?: string; extraLocales?: string[]; host?: string };
  chrome?: { item?: string; publisher?: string; testItems?: string[]; browser?: string; profile?: string };
}

export function configPath(root: string): string {
  return join(localizerDir(root), "config.json");
}

/** A bad config file or a bad --store value. The CLI exits with 2. */
export class ConfigError extends Error {}

interface Shape {
  [key: string]: "string" | "string[]" | Shape;
}

const SHAPE: Shape = {
  provider: "string",
  model: "string",
  effort: "string",
  formality: "string",
  to: "string",
  glossary: "string",
  stores: "string[]",
  listing: { dir: "string" },
  manifest: "string",
  locales: { dir: "string" },
  check: { ignoreKeys: "string[]", missingKeys: "string" },
  firefox: { addon: "string", defaultLocale: "string", extraLocales: "string[]", host: "string" },
  chrome: { item: "string", publisher: "string", testItems: "string[]", browser: "string", profile: "string" },
};

function validate(value: unknown, shape: Shape, where: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${where} must be an object`);
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const want = shape[key];
    const at = where ? `${where}.${key}` : key;
    if (want === undefined) throw new ConfigError(`unknown setting "${at}"`);
    if (want === "string") {
      if (typeof v !== "string") throw new ConfigError(`"${at}" must be a string`);
    } else if (want === "string[]") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ConfigError(`"${at}" must be an array of strings`);
    } else {
      validate(v, want, at);
    }
  }
}

export function parseConfig(data: unknown, label = "config"): Config {
  // "to" may also be an array; turn it into the flag form.
  if (data && typeof data === "object" && Array.isArray((data as { to?: unknown }).to)) {
    const to = (data as { to: unknown[] }).to;
    if (to.some((x) => typeof x !== "string")) throw new ConfigError(`${label}: "to" must be a string or an array of strings`);
    data = { ...(data as object), to: to.join(",") };
  }
  try {
    validate(data, SHAPE, "");
  } catch (e) {
    throw new ConfigError(`${label}: ${(e as Error).message}`);
  }
  const config = data as Config;
  if (config.formality !== undefined && !(FORMALITIES as readonly string[]).includes(config.formality)) {
    throw new ConfigError(`${label}: "formality" must be one of ${FORMALITIES.join(", ")}`);
  }
  const missing = config.check?.missingKeys;
  if (missing !== undefined && missing !== "error" && missing !== "warning") {
    throw new ConfigError(`${label}: "check.missingKeys" must be "error" or "warning"`);
  }
  for (const s of config.stores ?? []) {
    if (!(STORES as readonly string[]).includes(s)) throw new ConfigError(`${label}: unknown store "${s}" (use ${STORES.join(", ")})`);
  }
  return config;
}

/** Load .localizer/config.json (or an explicit file). A missing default file is an empty config. */
export function loadConfig(root: string, explicitPath?: string): Config {
  const path = explicitPath ?? configPath(root);
  if (!existsSync(path)) {
    if (explicitPath) throw new ConfigError(`config file not found: ${explicitPath}`);
    return {};
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`${path}: invalid JSON: ${(e as Error).message}`);
  }
  return parseConfig(data, path);
}

/** Parse a --store list ("chrome,firefox"). */
export function parseStores(value: string): Store[] {
  const out: Store[] = [];
  for (const raw of value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!(STORES as readonly string[]).includes(raw)) throw new ConfigError(`unknown store "${raw}" (use ${STORES.join(", ")})`);
    if (!out.includes(raw as Store)) out.push(raw as Store);
  }
  return out;
}
