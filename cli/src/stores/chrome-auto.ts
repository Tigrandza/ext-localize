import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { Descriptions } from "./chrome.ts";
import { DASHBOARD_URL, checkSaveAllowed, itemFromUrl, readFillCore } from "./chrome.ts";

/**
 * EXPERIMENTAL: fill, save and check the Chrome listing with no paste.
 * Ported from an earlier prototype (route 1: tested on a
 * real test item on 2026-11-17). Google has not confirmed that scripting the
 * dashboard is allowed (Developer Agreement 4.4.2 is unclear).
 *
 * Guards:
 * - --item is required; the open tab must be that item.
 * - Never clicks Publish or Submit for review. Only one button named exactly "Save draft".
 * - Saves only with --save, and only on items in chrome.testItems unless --allow-live.
 * - After saving: reload and read every language back.
 * - Nothing about the network traffic is recorded (the save request holds session tokens).
 */
export const AUTO_WARNING = `WARNING: --auto is EXPERIMENTAL.
It drives the Chrome Web Store dashboard from a script over the DevTools Protocol.
Google has NOT confirmed that this is allowed. The Developer Agreement (section 4.4.2)
forbids access "by any means other than through the interface", and it is unclear
whether a script that clicks the same interface counts. Your publisher account is
what is at risk. The default, lower-risk way is "ext-localize push chrome" (one paste).`;

export const DEFAULT_PROFILE = join(homedir(), ".ext-localize", "chrome-profile");
export const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface AutoOptions {
  item?: string;
  save?: boolean;
  allowLive?: boolean;
  testItems?: readonly string[];
  /** "launch" (default) or "port:<n>". */
  browser?: string;
  profile?: string;
  /** Page to open when no tab shows the item yet. */
  url?: string;
  /** Publisher id: lets the tool open the item page directly. */
  publisher?: string;
  headless?: boolean;
  /** How long to wait for the user to open the item page (ms). */
  waitMs?: number;
  log?: (line: string) => void;
}

export interface FillReport {
  filled: { locale: string; length: number; readBackOk: boolean }[];
  unmatched: { locale: string; dashboardCode: string; available?: string[] }[];
  tooLong: { locale: string; length: number }[];
  errors: { locale: string; error: string }[];
  verify: { ok: boolean; mismatches: unknown[] } | null;
  hint: string | null;
}

export interface AutoReport {
  date: string;
  browser: string;
  item: string | null;
  fill?: FillReport;
  fillOk?: boolean;
  saved?: boolean;
  afterReload?: { ok: boolean; rows: { locale: string; ok: boolean; error?: string; gotLength?: number; wantLength?: number }[] };
  error?: string;
}

type PW = { chromium: typeof import("playwright-core").chromium };

/** Playwright is an optional peer dependency: only --auto needs it. */
export async function loadPlaywright(): Promise<PW> {
  for (const name of ["playwright-core", "playwright"]) {
    try {
      const mod = (await import(name)) as Partial<PW> & { default?: Partial<PW> };
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return { chromium };
    } catch {
      // try the next one
    }
  }
  throw new Error(
    `--auto needs Playwright, which is not installed (it is optional to keep the default install small).\n` +
      `Install it next to ext-localize: npm install playwright-core\n` +
      `It uses your installed Google Chrome; no browser download is needed.`,
  );
}

/** Open plain Chrome (no automation) on the --auto profile, so you can sign in to Google once. */
export function openLoginBrowser(profile: string, executable = MAC_CHROME): void {
  if (!existsSync(executable)) throw new Error(`Google Chrome not found at ${executable}`);
  mkdirSync(profile, { recursive: true });
  const child = spawn(executable, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", DASHBOARD_URL], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function getBrowser(pw: PW, o: AutoOptions): Promise<{ ctx: BrowserContext; done: () => Promise<void> }> {
  const how = o.browser ?? "launch";
  if (how === "launch") {
    const profile = resolve(o.profile ?? DEFAULT_PROFILE);
    mkdirSync(profile, { recursive: true });
    const ctx = await pw.chromium.launchPersistentContext(profile, {
      channel: "chrome",
      headless: o.headless ?? false,
      viewport: null,
      // Without these, Chrome cannot read cookies saved by plain Chrome (the Google sign-in).
      ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
    });
    return { ctx, done: () => ctx.close() };
  }
  const port = /^port:(\d+)$/.exec(how);
  if (!port) throw new Error(`--browser must be "launch" or "port:<number>", not "${how}"`);
  const browser: Browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port[1]}`, { timeout: 30000 });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("connected, but Chrome has no browser context");
  // Disconnect only; the Chrome you started stays open.
  return { ctx, done: () => browser.close() };
}

async function findDashboardPage(ctx: BrowserContext, o: AutoOptions): Promise<Page> {
  const want = (p: Page) => itemFromUrl(p.url()) === o.item;
  const open = ctx.pages().find(want);
  if (open) return open;
  const page = await ctx.newPage();
  const start = o.url ?? (o.publisher ? `${DASHBOARD_URL}${o.publisher}/${o.item}/edit` : DASHBOARD_URL);
  await page.goto(start);
  if (want(page)) return page;
  o.log?.(`Open item ${o.item} and its "Store listing" tab in this window. Waiting up to ${Math.round((o.waitMs ?? 900000) / 60000)} min.`);
  const end = Date.now() + (o.waitMs ?? 15 * 60 * 1000);
  while (Date.now() < end) {
    for (const p of ctx.pages()) if (want(p)) return p;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for the item page.");
}

async function inject(page: Page, core: string): Promise<void> {
  // DevTools Protocol: not blocked by the page CSP, and not an extension.
  await page.evaluate(core);
  await page.waitForFunction(
    () => {
      try {
        return !!(globalThis as unknown as { ListingFill: { findTextarea(): unknown } }).ListingFill.findTextarea();
      } catch {
        return false;
      }
    },
    null,
    { timeout: 60000 },
  );
}

type ListingFillApi = {
  run(l: Descriptions, o: Record<string, unknown>): Promise<FillReport>;
  selectLocale(l: string): Promise<{ ok: boolean }>;
  findTextarea(): { el: HTMLTextAreaElement };
};

async function fill(page: Page, core: string, descriptions: Descriptions): Promise<FillReport> {
  await inject(page, core);
  return page.evaluate(
    (l) =>
      (globalThis as unknown as { ListingFill: ListingFillApi }).ListingFill.run(l, {
        mode: "fill-all",
        save: "none",
        verify: true,
        log: () => {},
      }),
    descriptions,
  );
}

/** After a reload: switch to each language and compare the box with the file. Changes nothing. */
async function verifySaved(page: Page, core: string, descriptions: Descriptions): Promise<NonNullable<AutoReport["afterReload"]>> {
  await inject(page, core);
  const want = Object.fromEntries(Object.entries(descriptions).map(([k, v]) => [k, v.description]));
  return page.evaluate(async (want) => {
    const L = (globalThis as unknown as { ListingFill: ListingFillApi }).ListingFill;
    const norm = (s: string) => String(s || "").replace(/\r\n/g, "\n").trim();
    const rows: { locale: string; ok: boolean; error?: string; gotLength?: number; wantLength?: number }[] = [];
    for (const loc of Object.keys(want).sort()) {
      try {
        const sel = await L.selectLocale(loc);
        if (!sel.ok) {
          rows.push({ locale: loc, ok: false, error: "language not in dropdown" });
          continue;
        }
        const got = norm(L.findTextarea().el.value);
        const w = norm(want[loc] as string);
        rows.push({ locale: loc, ok: got === w, gotLength: got.length, wantLength: w.length });
      } catch (e) {
        rows.push({ locale: loc, ok: false, error: (e as Error).message });
      }
    }
    return { ok: rows.length > 0 && rows.every((r) => r.ok), rows };
  }, want);
}

/** Run --auto. Never throws for page problems: they end up in report.error. */
export async function runAuto(descriptions: Descriptions, o: AutoOptions, pw?: PW): Promise<AutoReport> {
  const log = o.log ?? (() => {});
  const report: AutoReport = { date: new Date().toISOString(), browser: o.browser ?? "launch", item: null };
  // Fail before opening a browser when the flags alone are not enough.
  if (!o.item) throw new Error("Refusing: --auto needs --item <itemId>.");
  const playwright = pw ?? (await loadPlaywright());
  const core = readFillCore();
  const b = await getBrowser(playwright, o);
  try {
    const page = await findDashboardPage(b.ctx, o);
    report.item = itemFromUrl(page.url());
    checkSaveAllowed(report.item, o);
    await page.bringToFront().catch(() => {});

    report.fill = await fill(page, core, descriptions);
    report.fillOk = !!report.fill.verify?.ok && !report.fill.errors.length && !report.fill.unmatched.length && !report.fill.tooLong.length;
    log(report.fillOk ? `Filled and checked ${report.fill.filled.length} language(s) (not saved yet).` : "Fill had problems; not saving.");

    if (o.save && report.fillOk) {
      const btn = page.getByRole("button", { name: "Save draft", exact: true });
      const n = await btn.count();
      if (n !== 1) throw new Error(`Expected exactly one "Save draft" button, found ${n}.`);
      const label = (await btn.textContent()) ?? "";
      if (/submit|publish|review/i.test(label)) throw new Error("Refusing: the button text looks like submit or publish.");
      await btn.click(); // a real (trusted) click through the DevTools Protocol
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);
      report.saved = true;
      log("Clicked Save draft. Reloading to check what was kept.");
      await page.reload({ waitUntil: "domcontentloaded" });
      report.afterReload = await verifySaved(page, core, descriptions);
      log(report.afterReload.ok ? "After reload: every language has the new text." : "After reload: some languages differ. See the report.");
    } else if (!o.save) {
      log("No --save: nothing was saved. Reload the page without saving to undo, or click Save draft yourself.");
    }
  } catch (e) {
    report.error = (e as Error).message;
  } finally {
    await b.done().catch(() => {});
  }
  return report;
}

export function writeAutoReport(dir: string, report: AutoReport): string {
  const f = join(dir, `chrome-auto-${report.date.replace(/[:.]/g, "-")}.json`);
  writeFileSync(f, JSON.stringify(report, null, 2) + "\n");
  return f;
}
