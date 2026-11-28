import { existsSync } from "node:fs";
import { itemSize, makeBatches } from "./batch.ts";
import type { Glossary } from "./glossary.ts";
import { EMPTY_GLOSSARY, termsFor } from "./glossary.ts";
import { isChromeLocale } from "./locales.ts";
import type { ChromeMessage, MessagesFile, Project } from "./messages.ts";
import { listLocaleDirs, messagesPath, readMessagesFile, writeJsonAtomic } from "./messages.ts";
import { protect, restoreAndVerify } from "./placeholders.ts";
import type { BatchLimits, BatchRequest, Formality, Provider, TranslationItem } from "./providers/types.ts";
import { OutputTruncatedError, ProviderError } from "./providers/types.ts";
import type { LocalePlan, StateFile, StateSection } from "./state.ts";
import { applyPlan, hashSource, hashTarget, planLocale, saveState, statePath } from "./state.ts";
import { MANIFEST_LIMITS } from "./check.ts";
import { localeFileRel, relPath } from "./paths.ts";

/**
 * One kind of file set to translate: the _locales messages, or the store
 * listing. Both are planned and diffed the same way (see state.ts); the job
 * says how to read and write the files and which rules apply.
 */
export interface TranslationJob {
  kind: "messages" | "listing";
  root: string;
  sourceLocale: string;
  /** Source units as message entries: key -> {message, description}. */
  source: MessagesFile;
  /** Where the diff state for this job lives in state.json. */
  section: StateSection;
  /** true: protect and check Chrome format tokens ($1, $name$, $$). false for listing text. */
  formatTokens: boolean;
  /** Current target for a locale, as message entries. data null = no file yet. */
  read(locale: string): { ok: true; data: Record<string, unknown> | null } | { ok: false; error: string };
  write(locale: string, file: MessagesFile): void;
  /** Path of a locale's file relative to root, with "/" separators (for reports). */
  fileFor(locale: string): string;
  /** Keys with a fixed value for this locale (not translated), for example the listing name copied from _locales. */
  fixed?(locale: string): Record<string, string>;
  /** Max length in characters (code points) per key. A longer translation is not written. */
  maxLength?: Record<string, number>;
  /** Length limit per key that is only told to the model (not enforced; "check" warns). */
  lengthHint?: Record<string, number>;
}

export interface TranslateOptions {
  /** Target locales (already normalized). Default: existing locale folders except the source. */
  targets?: string[];
  provider?: Provider;
  /** Limits used for the dry-run request estimate when no provider is built. */
  limits?: BatchLimits;
  dryRun?: boolean;
  force?: boolean;
  glossary?: Glossary;
  /** Tone / form of address. DeepL: formality parameter. LLMs: an instruction. */
  formality?: Formality;
  /** Locales translated at the same time. */
  concurrency?: number;
  /** Override provider maxItems. */
  batchSize?: number;
  log?: (line: string) => void;
}

export interface LocaleResult {
  locale: string;
  plan: LocalePlan;
  requests: number;
  translated: string[];
  failed: { key: string; error: string }[];
  skipped?: string;
  /** Files written for this locale, relative to the extension folder. */
  written: string[];
}

export interface TranslateResult {
  locales: LocaleResult[];
  /** Set when the run stopped early (auth, quota, or repeated failures). */
  stopped?: string;
  totalRequests: number;
  /** Characters of the strings to translate (what DeepL bills). */
  totalChars: number;
  /** Characters sent including descriptions and marker notes (for LLM token estimates). */
  totalPromptChars: number;
  /** Number of strings to translate across all locales. */
  totalStrings: number;
  failedCount: number;
  /** Every file this run changed, relative to the extension folder, sorted. */
  filesWritten: string[];
}

interface Protected {
  item: TranslationItem;
  originals: string[];
  source: string;
}

function findPlaceholder(msg: ChromeMessage, name: string) {
  const ph = msg.placeholders ?? {};
  const key = Object.keys(ph).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? ph[key] : undefined;
}

/** Build the protected item for one source message. */
export function prepareItem(
  key: string,
  msg: ChromeMessage,
  glossary: Glossary,
  opts: { formatTokens?: boolean; maxLength?: number } = {},
): Protected {
  const p = protect(msg.message, glossary.keep, { formatTokens: opts.formatTokens });
  const hints: string[] = [];
  p.originals.forEach((orig, id) => {
    const named = /^\$([A-Za-z0-9_@]+)\$$/.exec(orig);
    if (named) {
      const def = findPlaceholder(msg, named[1] as string);
      const ex = def?.example ? ` (example: "${def.example}")` : "";
      hints.push(`<x id="${id}"/> = placeholder ${orig}${ex}`);
    } else if (/^\$[1-9]$/.test(orig)) hints.push(`<x id="${id}"/> = runtime value ${orig}`);
    else if (orig === "$$") hints.push(`<x id="${id}"/> = a literal "$" sign`);
  });
  const item: TranslationItem = { key, text: p.text };
  const description = [msg.description, opts.maxLength ? `Maximum length: ${opts.maxLength} characters.` : undefined]
    .filter(Boolean)
    .join(" ");
  if (description) item.description = description;
  if (hints.length) item.markerHints = hints;
  return { item, originals: p.originals, source: msg.message };
}

/** Run one batch; if the output was cut off, split the batch and try again. */
async function runBatch(
  provider: Provider,
  base: Omit<BatchRequest, "items">,
  items: TranslationItem[],
  counter: { requests: number },
): Promise<Record<string, string>> {
  counter.requests++;
  try {
    return await provider.translateBatch({ ...base, items });
  } catch (e) {
    if (e instanceof OutputTruncatedError && items.length > 1) {
      const mid = Math.ceil(items.length / 2);
      const a = await runBatch(provider, base, items.slice(0, mid), counter);
      const b = await runBatch(provider, base, items.slice(mid), counter);
      return { ...a, ...b };
    }
    throw e;
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * How many times a translation over its length limit is sent back to the model
 * with a "make it shorter" request (LLM providers only). After that the long text
 * is reported as before: a listing field fails, a manifest message is written and
 * "check" warns.
 */
export const SHORTEN_ATTEMPTS = 3;

/** Stop the whole run after this many failed requests in a row (bad key, network down, wrong model). */
export const MAX_FAILURES_IN_ROW = 3;

/**
 * How to react to an error thrown by a batch:
 * - fatal:     stop the run (401/403 auth, 404 wrong model or URL, 456 DeepL quota)
 * - content:   the answer was unusable (bad JSON, refusal); re-send keys one by one
 * - transport: network or HTTP error after the provider's own retries; fail the batch once
 */
export function classifyError(e: unknown): "fatal" | "content" | "transport" {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === "number" && [401, 403, 404, 456].includes(status)) return "fatal";
  // A single item too long for one answer: that item fails, the run goes on.
  if (e instanceof ProviderError || e instanceof OutputTruncatedError) return "content";
  return "transport";
}

export function defaultTargets(project: Project): string[] {
  return listLocaleDirs(project.localesDir).filter((l) => l !== project.defaultLocale && isChromeLocale(l));
}

/** The _locales/<locale>/messages.json job. */
export function messagesJob(project: Project): TranslationJob {
  return {
    kind: "messages",
    root: project.root,
    sourceLocale: project.defaultLocale,
    source: project.source,
    section: "messages",
    formatTokens: true,
    read(locale) {
      const path = messagesPath(project.localesDir, locale);
      if (!existsSync(path)) return { ok: true, data: null };
      const r = readMessagesFile(path);
      return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
    },
    write(locale, file) {
      writeJsonAtomic(messagesPath(project.localesDir, locale), file);
    },
    fileFor: (locale) => localeFileRel(project.root, locale),
    lengthHint: manifestLengthHints(project.manifest),
  };
}

/**
 * Store limits for the messages the manifest uses as name, short_name and description
 * (75 / 12 / 132). Told to the model so a translation fits; "check" warns when one does not.
 */
export function manifestLengthHints(manifest: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [field, max] of Object.entries(MANIFEST_LIMITS)) {
    const value = manifest[field];
    const ref = typeof value === "string" ? /^__MSG_([A-Za-z0-9_@]+)__$/.exec(value) : null;
    if (!ref) continue;
    const key = ref[1] as string;
    out[key] = Math.min(out[key] ?? max, max);
  }
  return out;
}

/**
 * Translate (or, with dryRun, plan) every target locale of _locales.
 * Writes each locale file and the state file after that locale is done,
 * so an interrupted run keeps the finished locales.
 */
export async function translateProject(project: Project, state: StateFile, opts: TranslateOptions): Promise<TranslateResult> {
  const targets = opts.targets ?? defaultTargets(project);
  return runJob(messagesJob(project), state, { ...opts, targets });
}

/** Run one translation job over its target locales. */
export async function runJob(job: TranslationJob, state: StateFile, opts: TranslateOptions & { targets: string[] }): Promise<TranslateResult> {
  const log = opts.log ?? (() => {});
  const glossary = opts.glossary ?? EMPTY_GLOSSARY;
  const provider = opts.provider;
  const baseLimits = provider?.limits ?? opts.limits ?? { maxItems: 40, maxChars: 8000 };
  const limits: BatchLimits = opts.batchSize ? { ...baseLimits, maxItems: opts.batchSize } : baseLimits;
  const targets = opts.targets.filter((l) => l !== job.sourceLocale);
  const source: MessagesFile = job.source;
  const checkFormat = job.formatTokens;

  const prepared = new Map<string, Protected>();
  for (const [key, msg] of Object.entries(source)) {
    prepared.set(key, prepareItem(key, msg, glossary, { formatTokens: job.formatTokens, maxLength: job.maxLength?.[key] ?? job.lengthHint?.[key] }));
  }

  const results: LocaleResult[] = [];
  const ctx: { fatal: Error | null; failuresInRow: number } = { fatal: null, failuresInRow: 0 };
  let totalChars = 0;
  let totalPromptChars = 0;
  let stateWritten = false;

  await pool(targets, opts.dryRun ? targets.length : (opts.concurrency ?? 4), async (locale) => {
    const emptyPlan: LocalePlan = { locale, translate: [], remove: [], keep: [], adopt: [], manual: [] };
    const r = job.read(locale);
    if (!r.ok) {
      results.push({ locale, plan: emptyPlan, requests: 0, translated: [], failed: [], written: [], skipped: `${r.error}; fix or delete the file first` });
      return;
    }
    const target = r.data;
    const sectionState = { messages: state.locales[locale]?.[job.section] ?? {} };
    const plan = planLocale(source, target, sectionState, locale, { force: opts.force, checkFormat });
    // Fixed keys are copied, never translated.
    const fixed = job.fixed?.(locale) ?? {};
    const isFree = (key: string) => !(key in fixed);
    plan.translate = plan.translate.filter((t) => isFree(t.key));
    plan.keep = plan.keep.filter(isFree);
    plan.adopt = plan.adopt.filter(isFree);
    plan.manual = plan.manual.filter(isFree);
    const items = plan.translate.map((t) => (prepared.get(t.key) as Protected).item);
    const batches = makeBatches(items, limits);
    const result: LocaleResult = { locale, plan, requests: batches.length, translated: [], failed: [], written: [] };
    results.push(result);
    for (const it of items) {
      totalChars += it.text.length;
      totalPromptChars += itemSize(it);
    }

    if (opts.dryRun) return;
    if (!provider) throw new Error("no provider");
    if (ctx.fatal) {
      result.skipped = `not started: ${ctx.fatal.message}`;
      result.requests = 0;
      return;
    }

    try {
      if (provider.supportsLocale && !(await provider.supportsLocale(locale))) {
        result.skipped = `${provider.name} does not support this locale`;
        result.requests = 0;
        log(`${locale}: skipped (${result.skipped})`);
        return;
      }
    } catch (e) {
      // The language list is shared by all locales, so this stops the run.
      ctx.fatal ??= new Error(`cannot get the language list: ${(e as Error).message}`);
      result.skipped = `not started: ${ctx.fatal.message}`;
      result.requests = 0;
      return;
    }

    const base: Omit<BatchRequest, "items"> = {
      sourceLocale: job.sourceLocale,
      targetLocale: locale,
      terms: termsFor(glossary, locale),
      formality: opts.formality,
      kind: job.kind,
    };
    if (provider.prepareLocale && items.length) {
      try {
        for (const note of await provider.prepareLocale(base)) log(`${locale}: ${note}`);
      } catch (e) {
        if (classifyError(e) === "fatal") {
          ctx.fatal ??= e as Error;
          result.skipped = `not started: ${(e as Error).message}`;
          result.requests = 0;
          return;
        }
        // Not fatal: translate without the extras (glossary, formality).
        log(`${locale}: setup failed, translating without glossary/formality: ${(e as Error).message}`);
      }
    }
    const counter = { requests: 0 };
    const good: Record<string, string> = {};
    const errors = new Map<string, string>();
    // Translations over their length limit: key -> the answer with markers and its length.
    const tooLong = new Map<string, { raw: string; length: number }>();

    /**
     * Send translations that are over their limit back to the model, up to SHORTEN_ATTEMPTS
     * times. A shorter answer that fits replaces the long one. Returns the keys that now fit.
     */
    const shortenTooLong = async (loc: string, pending: Map<string, { raw: string; length: number }>): Promise<string[]> => {
      const done: string[] = [];
      let attempts = 0;
      // What each shorten answer was, per key, for the report: a length, or why it was not used.
      const answers = new Map<string, string[]>();
      const note = (key: string, what: string) => answers.set(key, [...(answers.get(key) ?? []), what]);
      const limitOf = (key: string) => (job.maxLength?.[key] ?? job.lengthHint?.[key]) as number;
      while (pending.size && attempts < SHORTEN_ATTEMPTS && !ctx.fatal) {
        attempts++;
        const reqItems: TranslationItem[] = [...pending].map(([key, prev]) => ({
          ...(prepared.get(key) as Protected).item,
          shorten: { previous: prev.raw, length: prev.length, max: limitOf(key) },
        }));
        for (const batch of makeBatches(reqItems, limits)) {
          if (ctx.fatal) break;
          let out: Record<string, string>;
          try {
            out = await runBatch(provider, { ...base, kind: "shorten" }, batch, counter);
            ctx.failuresInRow = 0;
          } catch (e) {
            if (classifyError(e) === "fatal") ctx.fatal = e as Error;
            log(`${loc}: shorten request failed: ${(e as Error).message}`);
            continue;
          }
          for (const i of batch) {
            const raw = out[i.key];
            if (raw === undefined) {
              const got = Object.keys(out);
              note(i.key, got.length ? `no answer (got ${got.join(" ")})` : "no answer");
              continue;
            }
            const p = prepared.get(i.key) as Protected;
            const v = restoreAndVerify(p.source, raw, p.originals, { checkFormat });
            if (!v.ok) {
              note(i.key, "broken"); // keep the earlier one
              continue;
            }
            const length = [...v.text].length;
            note(i.key, String(length));
            const prev = pending.get(i.key) as { raw: string; length: number };
            if (length > prev.length) continue;
            const enforced = job.maxLength?.[i.key] !== undefined;
            if (length <= limitOf(i.key)) {
              pending.delete(i.key);
              done.push(i.key);
              good[i.key] = v.text;
              errors.delete(i.key);
            } else {
              pending.set(i.key, { raw, length });
              // A hint-only key is written anyway, so keep the shorter text.
              if (!enforced) good[i.key] = v.text;
            }
          }
        }
      }
      for (const [key, prev] of pending) {
        const tried = answers.get(key);
        const asked = attempts
          ? `; still too long after ${attempts} shorten request${attempts === 1 ? "" : "s"}` + (tried?.length ? ` (answers: ${tried.join(", ")})` : "")
          : "";
        if (job.maxLength?.[key] !== undefined) errors.set(key, `too long: ${prev.length} characters, limit ${limitOf(key)}${asked}`);
        // A hint-only key is written anyway; say so here, not only in "check".
        else log(`${loc} > ${key}: written with ${prev.length} characters, limit ${limitOf(key)}${asked}`);
      }
      return done;
    };

    // Pass 1 sends the batches. Pass 2 re-sends, one by one, only the keys that
    // came back missing or broken (or whose batch had an unusable answer).
    // A batch that fails on the network or HTTP level is not re-sent key by key.
    let retryOne: TranslationItem[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const passBatches = pass === 0 ? batches : retryOne.map((i) => [i]);
      const nextRetry: TranslationItem[] = [];
      for (const batch of passBatches) {
        if (ctx.fatal) {
          for (const i of batch) errors.set(i.key, `not sent: ${ctx.fatal.message}`);
          continue;
        }
        let out: Record<string, string>;
        try {
          out = await runBatch(provider, base, batch, counter);
          ctx.failuresInRow = 0;
        } catch (e) {
          const msg = (e as Error).message;
          for (const i of batch) errors.set(i.key, msg);
          // An item that does not fit in one answer. Re-send the batch key by key, so the
          // other keys are not lost; the long item alone will fail again and is reported.
          if (e instanceof OutputTruncatedError) {
            if (pass === 0 && batch.length > 1) nextRetry.push(...batch);
            continue;
          }
          const kind = classifyError(e);
          if (kind === "content" && pass === 0) nextRetry.push(...batch);
          if (kind === "fatal") ctx.fatal = e as Error;
          else if (kind === "transport" && ++ctx.failuresInRow >= MAX_FAILURES_IN_ROW) {
            ctx.fatal = new Error(`${MAX_FAILURES_IN_ROW} requests failed in a row, stopping. Last error: ${msg}`);
          }
          continue;
        }
        for (const i of batch) {
          const raw = out[i.key];
          const p = prepared.get(i.key) as Protected;
          let v = raw === undefined ? { ok: false as const, error: "no translation returned" } : restoreAndVerify(p.source, raw, p.originals, { checkFormat });
          const max = job.maxLength?.[i.key];
          if (v.ok && max !== undefined && [...v.text].length > max) {
            const length = [...v.text].length;
            v = { ok: false as const, error: `too long: ${length} characters, limit ${max}` };
            if (provider.canShorten) {
              // Asking again with the same prompt rarely helps; a shorten request follows below.
              tooLong.set(i.key, { raw: raw as string, length });
              errors.set(i.key, v.error);
              continue;
            }
          }
          if (v.ok) {
            good[i.key] = v.text;
            errors.delete(i.key);
            tooLong.delete(i.key);
            const hint = job.lengthHint?.[i.key];
            const length = [...v.text].length;
            if (provider.canShorten && hint !== undefined && length > hint) tooLong.set(i.key, { raw: raw as string, length });
          } else {
            errors.set(i.key, v.error);
            if (pass === 0) nextRetry.push(i);
          }
        }
      }
      retryOne = nextRetry;
      if (!retryOne.length) break;
    }
    const shortened = await shortenTooLong(locale, tooLong);
    result.failed = items.filter((i) => good[i.key] === undefined).map((i) => ({ key: i.key, error: errors.get(i.key) ?? "failed" }));
    result.requests = counter.requests;
    result.translated = Object.keys(good);

    const { file, state: sectionNew } = applyPlan(source, target, sectionState, plan, good, provider.label);
    for (const [key, value] of Object.entries(fixed)) {
      const src = source[key];
      if (!src) continue;
      file[key] = { message: value };
      sectionNew.messages[key] = { sourceHash: hashSource(src), targetHash: hashTarget(value), by: "_locales" };
    }
    const changed = !target || JSON.stringify(file) !== JSON.stringify(target);
    if (changed && Object.keys(file).length > 0) {
      job.write(locale, file);
      result.written.push(job.fileFor(locale));
    }
    // Replace only this job's section; the other section of the locale stays as it is.
    state.locales[locale] = { messages: {}, ...state.locales[locale], [job.section]: sectionNew.messages };
    if (saveState(job.root, state)) stateWritten = true;
    log(
      `${locale}: ${result.translated.length} translated, ${plan.remove.length} removed, ${plan.keep.length} kept` +
        (shortened.length ? `, ${shortened.length} shortened` : "") +
        (result.failed.length ? `, ${result.failed.length} FAILED` : "") +
        ` (${result.requests} request${result.requests === 1 ? "" : "s"})`,
    );
  });

  results.sort((a, b) => (a.locale < b.locale ? -1 : 1));
  return {
    stopped: ctx.fatal?.message,
    locales: results,
    totalRequests: results.reduce((n, r) => n + r.requests, 0),
    totalChars,
    totalPromptChars,
    totalStrings: results.reduce((n, r) => n + r.plan.translate.length, 0),
    failedCount: results.reduce((n, r) => n + r.failed.length, 0),
    filesWritten: [...results.flatMap((r) => r.written), ...(stateWritten ? [relPath(job.root, statePath(job.root))] : [])].sort(),
  };
}
