import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BatchRequest, Provider } from "../src/providers/types.ts";
import { OutputTruncatedError } from "../src/providers/types.ts";

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sample-extension");

/** Copy the sample extension to a temp folder so tests can write to it. */
export function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ext-localize-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Make a tiny extension in a temp folder from a map of path -> JSON value or raw string. */
export function makeExtension(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "ext-localize-"));
  for (const [path, value] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
  return dir;
}

export interface MockOptions {
  /** Keys whose first marker is dropped (simulates a model breaking a placeholder). */
  breakKeys?: Set<string>;
  /** Break only on the first attempt for these keys. */
  breakOnceKeys?: Set<string>;
  /** Keys left out of the response. */
  omitKeys?: Set<string>;
  /** Batches larger than this throw OutputTruncatedError. */
  truncateAbove?: number;
  /** Locales for which every call throws. */
  failLocales?: Set<string>;
  /** Return an error to throw for a call (callIndex starts at 0). */
  throwFor?: (req: BatchRequest, callIndex: number) => unknown;
  maxItems?: number;
}

/** Fake translator: "[de] " + text, markers untouched. Records every call. */
export class MockProvider implements Provider {
  readonly name = "mock";
  readonly label = "mock/test";
  readonly limits: { maxItems: number; maxChars: number };
  calls: BatchRequest[] = [];
  private brokenOnce = new Set<string>();
  private readonly opts: MockOptions;
  constructor(opts: MockOptions = {}) {
    this.opts = opts;
    this.limits = { maxItems: opts.maxItems ?? 10, maxChars: 100000 };
  }
  async translateBatch(req: BatchRequest): Promise<Record<string, string>> {
    this.calls.push(req);
    const err = this.opts.throwFor?.(req, this.calls.length - 1);
    if (err) throw err;
    if (this.opts.failLocales?.has(req.targetLocale)) throw new Error(`mock failure for ${req.targetLocale}`);
    if (this.opts.truncateAbove !== undefined && req.items.length > this.opts.truncateAbove) throw new OutputTruncatedError();
    const out: Record<string, string> = {};
    for (const item of req.items) {
      if (this.opts.omitKeys?.has(item.key)) continue;
      let text = `[${req.targetLocale}] ${item.text}`;
      const breakOnce = this.opts.breakOnceKeys?.has(item.key) && !this.brokenOnce.has(item.key);
      if (this.opts.breakKeys?.has(item.key) || breakOnce) {
        this.brokenOnce.add(item.key);
        text = text.replace(/<x id="\d+"\/>/, "");
      }
      out[item.key] = text;
    }
    return out;
  }
}
