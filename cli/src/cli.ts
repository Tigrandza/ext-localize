#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkProject, formatIssue } from "./check.ts";
import { loadGlossary } from "./glossary.ts";
import { parseTargetLocales } from "./locales.ts";
import { ProjectError, loadProject } from "./messages.ts";
import { createProvider, limitsFor, PROVIDER_NAMES } from "./providers/index.ts";
import { ANTHROPIC_DEFAULT_MODEL } from "./providers/anthropic.ts";
import { FORMALITIES, type Formality } from "./providers/types.ts";
import { loadState, statePath } from "./state.ts";
import { runJob, translateProject, type TranslateResult } from "./translate.ts";
import { ConfigError, loadConfig, parseStores } from "./config.ts";
import {
  clearLocalesDir,
  clearLocalizerDir,
  clearManifestPath,
  configBase,
  localesRel,
  relPath,
  setLocalesDir,
  setLocalizerDir,
  setManifestPath,
} from "./paths.ts";
import { recount, zipIssues } from "./zip.ts";
import { importDescriptions } from "./import.ts";
import { UsageError } from "./usage.ts";
import { STALE_MODES, type StaleMode } from "./stale.ts";
import {
  ListingError,
  defaultListingTargets,
  listingDir,
  listingJob,
  loadListing,
  readAllListings,
  type Listing,
} from "./listing.ts";
import { AMO_HOST, AMO_PROD_LOCALES, addonUrl, amoDefaultLocale, buildPatchBody, sendPatch } from "./stores/firefox.ts";
import {
  buildDiagnoseScript,
  buildPasteScript,
  chromeDescriptions,
  copyToClipboard,
  isItemId,
  outDir,
  type FillMode,
} from "./stores/chrome.ts";
import { AUTO_WARNING, DEFAULT_PROFILE, openLoginBrowser, runAuto, writeAutoReport } from "./stores/chrome-auto.ts";
import { edgeBlock, writeEdgeFiles } from "./stores/edge.ts";

const HELP = `ext-localize - translate, check and deliver Chrome extension _locales and store listings

Usage:
  ext-localize translate --provider <name> [--to <locales>] [options]
  ext-localize translate --listing --provider <name> [options]
  ext-localize check [options]
  ext-localize push firefox --addon <id> [--send]
  ext-localize push chrome [--copy]
  ext-localize push chrome --auto --item <id> [--save]     (EXPERIMENTAL)
  ext-localize push edge [--print]
  ext-localize listing import <folder | "path/{locale}.txt"> [--force]

translate options:
  --listing            Translate the store listing (listing/<locale>.json) instead of _locales
  --store <list>       With --listing: stores whose length limits apply (default: config "stores", else chrome)
  --json               Print a machine-readable result on stdout (progress goes to stderr)
  --provider <name>    ${PROVIDER_NAMES.join(" | ")}
  --to <locales>       "all" (all 55 Chrome locales) or a list: de,fr,pt-BR
                       Default: the locale folders that already exist.
  --model <id>         Model id. anthropic default: ${ANTHROPIC_DEFAULT_MODEL}.
                       Required for openai and ollama.
  --effort <level>     anthropic only: low | medium | high | xhigh | max (default: medium)
  --formality <value>  default | more | less | prefer_more | prefer_less
                       DeepL: its formality setting. LLMs: formal or informal tone.
  --glossary <file>    Default: .localizer/glossary.json if it exists
  --dry-run            Show what would be translated and the request count. No API calls.
  --force              Re-translate every key, even unchanged ones
  --batch-size <n>     Max strings per request
  --concurrency <n>    Locales translated at the same time (default: 4)

check options:
  --json               Machine-readable output
  --strict             Exit with an error on warnings too
  --store <list>       Stores whose listing limits apply: chrome,firefox,edge (default: config "stores", else chrome)
  --stale <level>      Stale strings (source changed after translation): warning (default) | error | off
  Config "check": {"ignoreKeys": ["appShortName", "*_zero"], "missingKeys": "warning"} drops
  issues for matching keys and makes keys missing in a non-default locale warnings.

push firefox options (dry run unless --send):
  --addon <id>         Add-on id, slug or guid (or config firefox.addon)
  --send               Really send the PATCH. Needs AMO_JWT_ISSUER and AMO_JWT_SECRET.
  --remove <list>      Also delete these AMO locales (sends null)
  --default-locale <c> The add-on default locale on AMO (default: from manifest default_locale)
  --extra-locales <l>  AMO locales to accept beyond the built-in list of 44
  --host <url>         Default: ${AMO_HOST}

push chrome options (default: write a script you paste into the dashboard):
  --copy               Also copy the script to the clipboard (macOS)
  --mode <m>           fill-all (default) | save-each
  --out <file>         Default: .localizer/out/chrome-paste.js
  --auto               EXPERIMENTAL: drive the dashboard over the DevTools Protocol (needs playwright-core)
  --item <id>          Item id (32 letters). Required with --auto (or config chrome.item).
  --save               With --auto: click "Save draft", reload and check. Never Publish or Submit.
  --allow-live         With --save: allow an item that is not in config chrome.testItems
  --browser <b>        launch (default) | port:<n>
  --profile <dir>      Chrome profile for launch (default: ~/.ext-localize/chrome-profile)
  --login              Open plain Chrome on that profile to sign in to Google once, then exit
  --url <url>          Open this page first instead of the dashboard (for testing on a local mock)
  --headless           Run Chrome without a window (for testing)
  --zip <file>         Warn about listing files the uploaded package (.zip) has no _locales folder for
The paste script is pure ASCII; its size is printed. Non-Latin text grows about 6x
(each character is written as a \\uXXXX escape).

push edge options:
  --print              Print copy-ready blocks instead of only writing files

check also:
  --listing-only       Only listing checks (and project-level problems)
  --zip <file>         Also compare listing files with the _locales in this package (.zip)

listing import: turn existing per-locale description files (.txt) into listing/<locale>.json.
  Name and summary come from _locales when the manifest uses __MSG_. --force overwrites.

Common:
  --dir <path>         Extension folder with manifest.json (default: current folder)
  --config <file>      Config file (default: <dir>/.localizer/config.json). state.json,
                       glossary.json and out/ are kept next to it. For WXT/Plasmo builds.
  --listing-dir <dir>  Listing folder (default: config listing.dir, else <dir>/listing)
  --locales-dir <dir>  _locales folder to read and write (default: config locales.dir, else
                       <dir>/_locales). For WXT/Plasmo: --dir .output/chrome-mv3 --locales-dir public/_locales
  --manifest <file>    manifest.json to read (default: config manifest, else <dir>/manifest.json).
                       With --locales-dir and --config, works before the first build.
  -h, --help           Show this help
  -v, --version        Show version

Exit codes: 0 ok, 1 failed (errors found, strings failed, run stopped), 2 usage or setup error,
3 translate had no target locales.

Keys are read from the environment only:
  ANTHROPIC_API_KEY, OPENAI_API_KEY (+ OPENAI_BASE_URL), DEEPL_API_KEY, OLLAMA_HOST,
  AMO_JWT_ISSUER, AMO_JWT_SECRET
Defaults for most options can be set in .localizer/config.json (see README).
`;

function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive whole number`);
  return n;
}


function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function printPlan(result: TranslateResult, dryRun: boolean, providerName: string | undefined): void {
  const rows = result.locales.map((r) => {
    const count = (reason: string) => r.plan.translate.filter((t) => t.reason === reason).length;
    return {
      locale: r.locale,
      new: count("new") + count("missing"),
      changed: count("changed"),
      invalid: count("invalid"),
      forced: count("forced"),
      removed: r.plan.remove.length,
      kept: r.plan.keep.length,
      requests: r.requests,
      note: shorten(r.skipped ?? (r.plan.manual.length ? `${r.plan.manual.length} edited by hand (kept)` : ""), 70),
    };
  });
  const head = ["locale", "new", "changed", "invalid", "forced", "removed", "kept", "requests", "note"];
  const table = [head, ...rows.map((r) => head.map((h) => String(r[h as keyof typeof r])))];
  const widths = head.map((_, i) => Math.max(...table.map((row) => (row[i] ?? "").length)));
  for (const row of table) console.log(row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd());
  console.log("");
  if (dryRun) {
    const head = `Dry run: ${result.totalStrings} string(s) to translate in ${result.locales.length} locale(s), about ${result.totalRequests} request(s)`;
    if (providerName === "deepl") {
      console.log(`${head} to DeepL, about ${result.totalChars} characters billed.`);
    } else {
      // Rough: ~3.5 chars per token, plus the fixed prompt per request; output about 1.5x the source text.
      const tokensIn = Math.ceil(result.totalPromptChars / 3.5 + result.totalRequests * 450);
      const tokensOut = Math.ceil((result.totalChars / 3.5) * 1.5 + result.totalStrings * 12);
      console.log(`${head} to ${providerName ?? "an LLM provider"}, roughly ${tokensIn} input and ${tokensOut} output tokens (rough guess).`);
    }
    console.log("Nothing was written.");
  }
}

/**
 * Resolve --dir, --config and --listing-dir.
 * --config <file>: ext-localize keeps state.json, glossary.json and out/ next to that
 * file, and resolves relative paths inside it from the folder that holds its folder
 * (for the default .localizer/config.json: the extension folder).
 */
function setup(values: { dir?: string; config?: string; "listing-dir"?: string; "locales-dir"?: string; manifest?: string }) {
  const root = resolve(values.dir ?? ".");
  const configFile = values.config ? resolve(values.config) : undefined;
  if (configFile) setLocalizerDir(root, dirname(configFile));
  else clearLocalizerDir(root);
  clearLocalesDir(root);
  clearManifestPath(root);
  const config = loadConfig(root, configFile);
  // --manifest is relative to the current folder; config manifest to the config base.
  if (values.manifest !== undefined || config.manifest !== undefined) {
    const file = values.manifest !== undefined ? resolve(values.manifest) : resolve(configBase(root), config.manifest as string);
    if (!existsSync(file)) {
      throw new ConfigError(
        `manifest not found: ${file} (from ${values.manifest !== undefined ? "--manifest" : `manifest "${config.manifest}"; a relative manifest is resolved from ${configBase(root)}`})`,
      );
    }
    setManifestPath(root, file);
  }
  // --locales-dir is relative to the current folder; config locales.dir to the config base.
  const localesFlag = values["locales-dir"];
  const localesConf = config.locales?.dir;
  if (localesFlag !== undefined || localesConf !== undefined) {
    const abs = localesFlag !== undefined ? resolve(localesFlag) : resolve(configBase(root), localesConf as string);
    if (!existsSync(abs)) {
      throw new ConfigError(
        `_locales folder not found: ${abs} (from ${localesFlag !== undefined ? "--locales-dir" : `locales.dir "${localesConf}"; a relative locales.dir is resolved from ${configBase(root)}`})`,
      );
    }
    setLocalesDir(root, abs);
  }
  const flagDir = values["listing-dir"];
  const abs = flagDir ? resolve(flagDir) : listingDir(root, config.listing?.dir, configBase(root));
  const listing = {
    dir: abs,
    rel: relPath(root, abs),
    explicit: flagDir !== undefined || config.listing?.dir !== undefined,
    /** A listing folder that was asked for must exist: never ignore it silently. */
    require(): void {
      if (this.explicit && !existsSync(abs)) {
        throw new ConfigError(
          `listing folder not found: ${abs} (from ${flagDir !== undefined ? "--listing-dir" : `listing.dir "${config.listing?.dir}"`}; ` +
            `a relative listing.dir is resolved from ${configBase(root)})`,
        );
      }
    },
  };
  return { root, config, listing };
}

/** Exit codes. See README "Exit codes". */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_NO_TARGETS = 3;

/** The `translate --json` result. See README "translate --json". */
function translateJson(
  result: TranslateResult,
  o: {
    listing: boolean;
    dryRun: boolean;
    provider: string | undefined;
    exitCode: number;
    noTargets: boolean;
    mayWrite: string[];
    check: { errors: number; warnings: number; stale: number } | null;
  },
) {
  return {
    command: "translate",
    target: o.listing ? "listing" : "messages",
    dryRun: o.dryRun,
    provider: o.provider ?? null,
    exitCode: o.exitCode,
    ok: o.exitCode === 0,
    noTargets: o.noTargets,
    stopped: result.stopped ?? null,
    locales: result.locales.map((r) => {
      const count = (reason: string) => r.plan.translate.filter((t) => t.reason === reason).length;
      return {
        locale: r.locale,
        new: count("new") + count("missing"),
        changed: count("changed"),
        invalid: count("invalid"),
        forced: count("forced"),
        removed: r.plan.remove.length,
        kept: r.plan.keep.length,
        adopted: r.plan.adopt.length,
        manual: r.plan.manual.length,
        translated: r.translated.length,
        failed: r.failed.length,
        requests: r.requests,
        skipped: r.skipped ?? null,
        failedKeys: r.failed,
        written: r.written,
      };
    }),
    totals: {
      strings: result.totalStrings,
      requests: result.totalRequests,
      characters: result.totalChars,
      failed: result.failedCount,
    },
    filesWritten: result.filesWritten,
    mayWrite: o.mayWrite,
    check: o.check,
  };
}

async function runTranslate(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      config: { type: "string" },
      "listing-dir": { type: "string" },
      "locales-dir": { type: "string" },
      manifest: { type: "string" },
      to: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      formality: { type: "string" },
      glossary: { type: "string" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      "batch-size": { type: "string" },
      concurrency: { type: "string" },
      listing: { type: "boolean" },
      store: { type: "string" },
      json: { type: "boolean" },
    },
    strict: true,
  });
  const json = values.json ?? false;
  // With --json, stdout carries only the JSON result; progress goes to stderr.
  const say = json ? (line: string) => console.error(line) : (line: string) => console.log(line);
  const { root, config, listing } = setup(values);
  if (values.store && !values.listing) throw new UsageError(`--store only works with --listing`);
  const stores = values.store ? parseStores(values.store) : config.stores;
  values.provider ??= config.provider;
  values.model ??= config.model;
  values.effort ??= config.effort;
  values.formality ??= config.formality;
  values.to ??= config.to;
  const project = loadProject(root);
  const targets = values.to ? parseTargetLocales(values.to, project.defaultLocale) : undefined;
  const dryRun = values["dry-run"] ?? false;
  if (!dryRun && !values.provider) throw new UsageError(`--provider is required (${PROVIDER_NAMES.join(", ")}). Use --dry-run to preview without one.`);
  if (values.provider && !(PROVIDER_NAMES as readonly string[]).includes(values.provider)) {
    throw new UsageError(`unknown provider "${values.provider}". Use one of: ${PROVIDER_NAMES.join(", ")}`);
  }
  const formality = values.formality;
  if (formality !== undefined && !(FORMALITIES as readonly string[]).includes(formality)) {
    throw new UsageError(`--formality must be one of ${FORMALITIES.join(", ")}`);
  }
  const provider = dryRun ? undefined : createProvider({ name: values.provider as string, model: values.model, effort: values.effort });
  // A --glossary flag is relative to the current folder; the config value to the extension folder.
  const glossaryFile = values.glossary ? resolve(values.glossary) : config.glossary ? resolve(configBase(root), config.glossary) : undefined;
  const glossary = loadGlossary(root, glossaryFile);
  const state = loadState(root, project.defaultLocale);

  if (!targets && !dryRun) {
    // Default targets are the existing folders; make that visible.
    say(values.listing ? `No --to given: using the existing locale folders and listing files.` : `No --to given: using the existing locale folders.`);
  }
  const common = {
    provider,
    limits: limitsFor(values.provider),
    dryRun,
    force: values.force,
    glossary,
    formality: formality as Formality | undefined,
    concurrency: positiveInt(values.concurrency, "--concurrency"),
    batchSize: positiveInt(values["batch-size"], "--batch-size"),
    log: say,
  };
  let result: TranslateResult;
  if (values.listing) {
    listing.require();
    const lp = loadListing(project, listing.dir);
    const synced = Object.entries(lp.synced).map(([f, k]) => `${f} <- ${k}`);
    if (synced.length) say(`Copied from _locales, not translated (manifest uses __MSG_): ${synced.join(", ")}`);
    result = await runJob(listingJob(project, lp, stores ?? ["chrome"]), state, {
      ...common,
      targets: targets ?? defaultListingTargets(project, lp.dir),
    });
  } else {
    result = await translateProject(project, state, { ...common, targets });
  }
  const stateRel = relPath(root, statePath(root));
  const mayWrite = values.listing ? [`${listing.rel}/<locale>.json`, stateRel] : [`${localesRel(root)}/<locale>/messages.json`, stateRel];
  const noTargets = result.locales.length === 0;
  let exitCode = noTargets ? EXIT_NO_TARGETS : 0;
  let check: { errors: number; warnings: number; stale: number } | null = null;
  if (!noTargets && !dryRun) {
    const report = checkProject(root, { stores, listingDir: listing.dir, ignoreKeys: config.check?.ignoreKeys, missingKeys: config.check?.missingKeys });
    check = { errors: report.errors, warnings: report.warnings, stale: report.stale };
    if (result.failedCount > 0 || result.stopped) exitCode = 1;
  }

  if (json) {
    console.log(JSON.stringify(translateJson(result, { listing: !!values.listing, dryRun, provider: values.provider, exitCode, noTargets, mayWrite, check }), null, 2));
    return exitCode;
  }
  if (noTargets) {
    console.log(`No target locales. Use --to (for example --to de,fr or --to all).`);
    return exitCode;
  }
  console.log("");
  printPlan(result, dryRun, values.provider);
  if (dryRun) return 0;

  const failures = result.locales.flatMap((r) => r.failed.map((f) => `FAILED  ${r.locale} > ${f.key}: ${f.error}`));
  for (const line of failures.slice(0, 20)) console.log(line);
  if (failures.length > 20) console.log(`... and ${failures.length - 20} more failed string(s)`);
  if (result.stopped) console.error(`Stopped early: ${result.stopped}`);
  console.log(`State saved to ${statePath(root)}`);
  if (check) {
    console.log(`check: ${check.errors} error(s), ${check.warnings} warning(s), ${check.stale} stale. Run "ext-localize check" for details.`);
  }
  return exitCode;
}

function runCheck(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      config: { type: "string" },
      "listing-dir": { type: "string" },
      "locales-dir": { type: "string" },
      manifest: { type: "string" },
      json: { type: "boolean" },
      strict: { type: "boolean" },
      store: { type: "string" },
      stale: { type: "string" },
      "listing-only": { type: "boolean" },
      zip: { type: "string" },
    },
    strict: true,
  });
  const { root, config, listing } = setup(values);
  const stores = values.store ? parseStores(values.store) : config.stores;
  const stale = values.stale ?? "warning";
  if (!(STALE_MODES as readonly string[]).includes(stale)) throw new UsageError(`--stale must be one of ${STALE_MODES.join(", ")}`);
  listing.require();
  const report = checkProject(root, {
    stores,
    listingDir: listing.dir,
    stale: stale as StaleMode,
    listingOnly: values["listing-only"],
    ignoreKeys: config.check?.ignoreKeys,
    missingKeys: config.check?.missingKeys,
  });
  if (values.zip) report.issues.push(...zipIssues(values.zip, listing.dir, listing.rel, report.defaultLocale));
  if (values.zip) recount(report);
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const issue of report.issues) console.log(formatIssue(issue));
    if (report.issues.length) console.log("");
    console.log(
      `${report.locales.length} locale(s) checked: ${report.errors} error(s), ${report.warnings} warning(s), ${report.stale} stale.`,
    );
    const failing = report.errors > 0 || (values.strict && report.warnings > 0);
    console.log(failing ? `FAILED (${report.errors} error(s)${values.strict ? `, ${report.warnings} warning(s) with --strict` : ""})` : "OK");
  }
  const fail = report.errors > 0 || (values.strict && report.warnings > 0);
  return fail ? 1 : 0;
}

const list = (s: string | undefined): string[] =>
  (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** All listing files, with the synced fields of the source filled in from _locales. */
function loadAllListings(root: string, listing: { dir: string; require(): void }): { listings: Record<string, Listing>; defaultLocale: string } {
  listing.require();
  const project = loadProject(root);
  const dir = listing.dir;
  const lp = loadListing(project, dir);
  const listings = readAllListings(dir, project.defaultLocale);
  listings[project.defaultLocale] = lp.source;
  return { listings, defaultLocale: project.defaultLocale };
}

async function runPushFirefox(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      config: { type: "string" },
      "listing-dir": { type: "string" },
      "locales-dir": { type: "string" },
      manifest: { type: "string" },
      addon: { type: "string" },
      send: { type: "boolean" },
      remove: { type: "string" },
      "default-locale": { type: "string" },
      "extra-locales": { type: "string" },
      host: { type: "string" },
    },
    strict: true,
  });
  const { root, config, listing } = setup(values);
  const addon = values.addon ?? config.firefox?.addon;
  if (!addon) throw new UsageError(`--addon <id|slug|guid> is required (or set firefox.addon in .localizer/config.json)`);
  const { listings, defaultLocale } = loadAllListings(root, listing);
  const supported = [...AMO_PROD_LOCALES, ...(config.firefox?.extraLocales ?? []), ...list(values["extra-locales"])];
  const amoDefault = values["default-locale"] ?? config.firefox?.defaultLocale ?? amoDefaultLocale(defaultLocale, supported) ?? "en-US";
  const result = buildPatchBody(listings, { supported, defaultLocale: amoDefault, remove: list(values.remove) });

  const url = addonUrl(values.host ?? config.firefox?.host ?? AMO_HOST, addon);
  const issuer = process.env.AMO_JWT_ISSUER;
  const secret = process.env.AMO_JWT_SECRET;
  console.log(`PATCH ${url}`);
  console.log("Content-Type: application/json");
  console.log(`Authorization: JWT <redacted; AMO_JWT_ISSUER ${issuer ? "set" : "not set"}, AMO_JWT_SECRET ${secret ? "set" : "not set"}>`);
  console.log("");
  console.log(JSON.stringify(result.body, null, 2));
  console.log("");
  console.log(`AMO default locale: ${amoDefault}`);
  console.log("Locale sources: " + (Object.entries(result.sources).map(([a, c]) => `${a}<-${c}`).join(" ") || "(none)"));
  const skipped = result.warnings.filter((w) => w.startsWith("skip "));
  if (skipped.length) {
    console.log(`Cannot be sent to AMO (${skipped.length}):`);
    for (const w of skipped) console.log(`  ${w.slice(5)}`);
  }
  for (const w of result.warnings.filter((w) => !w.startsWith("skip "))) console.error(`warning: ${w}`);
  for (const e of result.errors) console.error(`error: ${e}`);

  if (result.errors.length > 0) {
    console.error(`\n${result.errors.length} error(s); not sending.`);
    return 1;
  }
  if (!values.send) {
    console.error(`\nDry run: nothing sent. Add --send (and set AMO_JWT_ISSUER, AMO_JWT_SECRET) to send.`);
    return 0;
  }
  if (!issuer || !secret) {
    console.error(`\nError: --send needs AMO_JWT_ISSUER and AMO_JWT_SECRET in the environment.`);
    return 2;
  }
  const res = await sendPatch(url, result.body, { issuer, secret });
  console.error(`\nHTTP ${res.status}`);
  console.log(res.text);
  return res.ok ? 0 : 1;
}

async function runPushChrome(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      config: { type: "string" },
      "listing-dir": { type: "string" },
      "locales-dir": { type: "string" },
      manifest: { type: "string" },
      copy: { type: "boolean" },
      mode: { type: "string" },
      out: { type: "string" },
      auto: { type: "boolean" },
      item: { type: "string" },
      save: { type: "boolean" },
      "allow-live": { type: "boolean" },
      browser: { type: "string" },
      profile: { type: "string" },
      login: { type: "boolean" },
      url: { type: "string" },
      headless: { type: "boolean" },
      zip: { type: "string" },
    },
    strict: true,
  });
  const { root, config, listing } = setup(values);
  const mode = (values.mode ?? "fill-all") as FillMode;
  if (mode !== "fill-all" && mode !== "save-each") throw new UsageError(`--mode must be fill-all or save-each`);

  if (!values.auto) {
    for (const flag of ["item", "save", "allow-live", "browser", "profile", "login", "url", "headless"] as const) {
      if (values[flag] !== undefined) throw new UsageError(`--${flag} only works with --auto`);
    }
    const { listings } = loadAllListings(root, listing);
    const { descriptions, problems } = chromeDescriptions(listings);
    for (const p of problems) console.error(`skip ${p}`);
    if (!Object.keys(descriptions).length) {
      console.error("Error: no description to fill.");
      return 1;
    }
    const dir = outDir(root);
    const file = values.out ? resolve(values.out) : `${dir}/chrome-paste.js`;
    const script = buildPasteScript(descriptions, { mode });
    writeFileSync(file, script);
    const diag = `${dir}/chrome-diagnose.js`;
    writeFileSync(diag, buildDiagnoseScript(Object.keys(descriptions)));
    console.log(`Wrote ${file} (${Object.keys(descriptions).length} language(s): ${Object.keys(descriptions).join(", ")})`);
    console.log(`Wrote ${diag} (read-only check, changes nothing)`);
    if (values.zip) {
      const project = loadProject(root);
      const zi = zipIssues(resolve(values.zip), listing.dir, listing.rel, project.defaultLocale);
      for (const i of zi) console.log(`warn   ${i.locale}: ${i.message}`);
      if (!zi.length) console.log(`The package ${values.zip} has a _locales folder for every listing file.`);
    }
    console.log(`Script size: ${Math.round(Buffer.byteLength(script) / 1024)} KB (pure ASCII; each description carries its length and hash, and the script fills nothing if they do not match).`);
    if (values.copy) {
      const err = copyToClipboard(script);
      if (err) {
        console.error(`Error: could not copy: ${err}`);
        return 1;
      }
      console.log("Copied the script to the clipboard and read it back: it matches the file.");
    }
    console.log(`
Steps:
  1. In Chrome, open the Developer Dashboard, your item, then the "Store listing" tab.
  2. Open the DevTools console: Cmd+Option+J (Mac) or Ctrl+Shift+J.
  3. Paste the script${values.copy ? " (it is on the clipboard)" : ""} and press Enter.
     The first time, Chrome may ask you to type "allow pasting".
  4. Wait for the report in the console. Check a few languages.
  5. Click "Save draft" yourself.${mode === "save-each" ? " (save-each: the script waits for your click after each language.)" : ""}
Name and summary come from _locales (the manifest); only the description is filled here.
The script never clicks Submit for review or Publish.`);
    return 0;
  }

  console.error(AUTO_WARNING + "\n");
  const profile = values.profile ?? config.chrome?.profile ?? DEFAULT_PROFILE;
  if (values.login) {
    openLoginBrowser(resolve(profile.replace(/^~(?=\/)/, process.env.HOME ?? "~")));
    console.log(`Opened Chrome on ${profile}. Sign in to Google, open the dashboard once, then quit Chrome (Cmd+Q).`);
    return 0;
  }
  const item = values.item ?? config.chrome?.item;
  if (!item) throw new UsageError(`--auto needs --item <itemId> (or chrome.item in .localizer/config.json)`);
  if (!isItemId(item)) throw new UsageError(`--item must be a 32-letter Chrome item id (letters a-p), not "${item}"`);
  const { listings } = loadAllListings(root, listing);
  const { descriptions, problems } = chromeDescriptions(listings);
  for (const p of problems) console.error(`skip ${p}`);
  if (!Object.keys(descriptions).length) {
    console.error("Error: no description to fill.");
    return 1;
  }
  const report = await runAuto(descriptions, {
    item,
    save: values.save,
    allowLive: values["allow-live"],
    testItems: config.chrome?.testItems,
    browser: values.browser ?? config.chrome?.browser,
    profile: resolve(profile.replace(/^~(?=\/)/, process.env.HOME ?? "~")),
    publisher: config.chrome?.publisher,
    url: values.url,
    headless: values.headless,
    log: (line) => console.log(line),
  });
  const file = writeAutoReport(outDir(root), report);
  const f = report.fill;
  if (f) {
    for (const u of f.unmatched) console.log(`not in the dashboard language list: ${u.locale} (${u.dashboardCode})`);
    for (const e of f.errors) console.log(`error ${e.locale}: ${e.error}`);
    if (f.hint) console.log(f.hint);
  }
  for (const r of report.afterReload?.rows.filter((r) => !r.ok) ?? []) console.log(`after reload, ${r.locale} differs: ${r.error ?? `${r.gotLength} vs ${r.wantLength} chars`}`);
  if (report.error) console.error(`Error: ${report.error}`);
  console.log(`Report: ${file}`);
  const ok = !report.error && report.fillOk && (!values.save || report.afterReload?.ok === true);
  return ok ? 0 : 1;
}

function runPushEdge(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { dir: { type: "string" }, config: { type: "string" }, "listing-dir": { type: "string" },
      "locales-dir": { type: "string" },
      manifest: { type: "string" }, print: { type: "boolean" } },
    strict: true,
  });
  const { root, config, listing } = setup(values);
  const { listings } = loadAllListings(root, listing);
  const dir = `${outDir(root)}/edge`;
  const entries = writeEdgeFiles(listings, dir);
  if (values.print) for (const e of entries) if (e.file) console.log(edgeBlock(e.locale, listings[e.locale] ?? {}));
  for (const e of entries) console.log(`${e.locale.padEnd(7)} ${String(e.length).padStart(6)} chars  ${e.problem ?? "ok"}`);
  console.log(`
Wrote ${entries.filter((e) => e.file).length} file(s) to ${dir}
Edge has no API for listing text. In Partner Center, open your extension, "Store listings",
pick each language and paste its Description. Name and short description come from the
manifest (_locales), so they are not in these files.`);
  return entries.some((e) => e.problem) ? 1 : 0;
}

function runListing(args: string[]): number {
  const [sub1, ...rest] = args;
  if (sub1 !== "import") throw new UsageError(`listing needs a subcommand: import`);
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      dir: { type: "string" },
      config: { type: "string" },
      "listing-dir": { type: "string" },
      "locales-dir": { type: "string" },
      manifest: { type: "string" },
      force: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  const pattern = positionals[0];
  if (!pattern || positionals.length > 1) {
    throw new UsageError(`usage: ext-localize listing import <folder | "path/{locale}.txt"> [--force]`);
  }
  const { root, listing } = setup(values);
  const project = loadProject(root);
  const result = importDescriptions(project, listing.dir, resolve(pattern), { force: values.force });
  for (const r of result) console.log(`${r.locale.padEnd(7)} ${r.action.padEnd(8)} ${r.note ?? ""}`.trimEnd());
  const written = result.filter((r) => r.action === "written").length;
  console.log(`\nWrote ${written} listing file(s) to ${listing.rel}. Run "ext-localize check" to validate them.`);
  return 0;
}

async function runPush(args: string[]): Promise<number> {
  const [store, ...rest] = args;
  switch (store) {
    case "firefox":
      return runPushFirefox(rest);
    case "chrome":
      return runPushChrome(rest);
    case "edge":
      return runPushEdge(rest);
    default:
      throw new UsageError(`push needs a store: firefox, chrome or edge`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "translate":
        return await runTranslate(rest);
      case "check":
        return runCheck(rest);
      case "listing":
        return runListing(rest);
      case "push":
        return await runPush(rest);
      case "-v":
      case "--version":
        console.log(version());
        return 0;
      case undefined:
      case "-h":
      case "--help":
      case "help":
        console.log(HELP);
        return 0;
      default:
        console.error(`Unknown command "${command}".\n`);
        console.error(HELP);
        return 2;
    }
  } catch (e) {
    const err = e as Error & { code?: string };
    const usage =
      e instanceof UsageError || e instanceof ProjectError || e instanceof ListingError || e instanceof ConfigError || !!err.code?.startsWith("ERR_PARSE_ARGS");
    const code = usage ? EXIT_USAGE : EXIT_FAILED;
    if (argv.includes("--json")) {
      // Keep stdout machine-readable even on errors.
      console.log(JSON.stringify({ command: command ?? null, exitCode: code, ok: false, error: err.message }, null, 2));
    }
    if (e instanceof UsageError || err.code?.startsWith("ERR_PARSE_ARGS")) {
      console.error(`Error: ${err.message}\nRun "ext-localize --help" for usage.`);
    } else {
      console.error(`Error: ${err.message}`);
    }
    return code;
  }
}

// npm installs the bin as a symlink, so compare real paths.
function isMainModule(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
const isMain = isMainModule();
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
