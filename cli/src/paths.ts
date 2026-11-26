import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Where ext-localize keeps its own files (config.json, state.json, glossary.json, out/).
 * Default: <extension folder>/.localizer. With --config <file>, it is the folder of
 * that file, so build tools that wipe the extension folder (WXT, Plasmo) do not
 * delete the state. Kept per extension root, set once by the CLI.
 */
const overrides = new Map<string, string>();

export function setLocalizerDir(root: string, dir: string): void {
  overrides.set(resolve(root), resolve(dir));
}

export function clearLocalizerDir(root: string): void {
  overrides.delete(resolve(root));
}

export function localizerDir(root: string): string {
  return overrides.get(resolve(root)) ?? join(root, ".localizer");
}

/**
 * Folder that relative paths inside config.json are resolved from: the folder
 * that holds the .localizer folder. For the default layout that is the extension folder.
 */
export function configBase(root: string): string {
  return resolve(localizerDir(root), "..");
}

/**
 * Where the _locales folder is. Default: <extension folder>/_locales. With
 * --locales-dir (or config locales.dir) it can live elsewhere, for example
 * public/_locales in a WXT project, while manifest.json is read from the build
 * output. Kept per extension root, set once by the CLI.
 */
const localesOverrides = new Map<string, string>();

export function setLocalesDir(root: string, dir: string): void {
  localesOverrides.set(resolve(root), resolve(dir));
}

export function clearLocalesDir(root: string): void {
  localesOverrides.delete(resolve(root));
}

export function localesDirFor(root: string): string {
  return localesOverrides.get(resolve(root)) ?? join(root, "_locales");
}

/**
 * Where manifest.json is. Default: <extension folder>/manifest.json. With
 * --manifest (or config manifest) it can be any file, for example a manifest
 * kept in the repository while the build folder does not exist yet.
 */
const manifestOverrides = new Map<string, string>();

export function setManifestPath(root: string, file: string): void {
  manifestOverrides.set(resolve(root), resolve(file));
}

export function clearManifestPath(root: string): void {
  manifestOverrides.delete(resolve(root));
}

export function manifestPathFor(root: string): string {
  return manifestOverrides.get(resolve(root)) ?? join(root, "manifest.json");
}

/** manifest.json as a report path ("manifest.json" by default). */
export function manifestRel(root: string): string {
  return relPath(root, manifestPathFor(root));
}

/** _locales/<locale>/messages.json as a report path (relative to the extension folder). */
export function localeFileRel(root: string, locale: string): string {
  return relPath(root, join(localesDirFor(root), locale, "messages.json"));
}

/** The _locales folder as a report path ("_locales" by default). */
export function localesRel(root: string): string {
  return relPath(root, localesDirFor(root));
}

/** A path relative to the extension folder, with "/" separators (for reports and JSON). */
export function relPath(root: string, path: string): string {
  const r = relative(resolve(root), resolve(path));
  return (r === "" ? "." : r).split(sep).join("/");
}

export { isAbsolute };
