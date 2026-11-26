import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { after, before, describe, test } from "node:test";
import { main } from "../src/cli.ts";
import {
  asciiJson,
  buildDiagnoseScript,
  buildPasteScript,
  checkSaveAllowed,
  chromeDescriptions,
  copyToClipboard,
  defaultRun,
  isAscii,
  itemFromUrl,
  outDir,
  readFillCore,
  shortHash,
} from "../src/stores/chrome.ts";
import { MAC_CHROME, loadPlaywright, runAuto } from "../src/stores/chrome-auto.ts";
import { writeEdgeFiles } from "../src/stores/edge.ts";
import { copyFixture } from "./helpers.ts";

const ITEM = "abcdefghijklmnopabcdefghijklmnop";
const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";

async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const log = console.log;
  const err = console.error;
  let out = "";
  console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  console.error = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  try {
    return { result: await fn(), out };
  } finally {
    console.log = log;
    console.error = err;
  }
}

/** Fixture copy with en (source) + de, pt_BR, he listings. */
function listingFixture(config?: Record<string, unknown>): string {
  const dir = copyFixture();
  const w = (loc: string, d: string) =>
    writeFileSync(join(dir, `listing/${loc}.json`), JSON.stringify({ name: "TabNest", summary: "s", description: d }));
  w("de", "TabNest speichert deine Tabs.\n\n- Sitzungen speichern\n- Duplikate schließen");
  w("pt_BR", "O TabNest salva suas abas.\n\n- Salvar sessões");
  w("he", "TabNest שומר את הכרטיסיות שלך.");
  if (config) writeFileSync(join(dir, ".localizer/config.json"), JSON.stringify(config));
  return dir;
}

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

test("itemFromUrl: only dashboard hosts (and local test pages) count", () => {
  assert.equal(itemFromUrl(`https://chrome.google.com/webstore/devconsole/00000000-0000-0000-0000-000000000000/${ITEM}/edit`), ITEM);
  assert.equal(itemFromUrl(`http://127.0.0.1:9000/webstore/devconsole/p/${ITEM}/edit`), ITEM);
  assert.equal(itemFromUrl(`https://evil.example/webstore/devconsole/p/${ITEM}/edit`), null);
  assert.equal(itemFromUrl(`https://chrome.google.com/webstore/devconsole/p/`), null);
  assert.equal(itemFromUrl("not a url"), null);
});

test("checkSaveAllowed: item required, tab must match, saving needs a test item or --allow-live", () => {
  assert.throws(() => checkSaveAllowed(ITEM, {}), /--item/);
  assert.throws(() => checkSaveAllowed(OTHER, { item: ITEM }), /not --item/);
  assert.throws(() => checkSaveAllowed(null, { item: ITEM }), /\(none\)/);
  assert.doesNotThrow(() => checkSaveAllowed(ITEM, { item: ITEM }), "fill only is fine");
  assert.throws(() => checkSaveAllowed(ITEM, { item: ITEM, save: true }), /may be a live item/);
  assert.doesNotThrow(() => checkSaveAllowed(ITEM, { item: ITEM, save: true, testItems: [ITEM] }));
  assert.doesNotThrow(() => checkSaveAllowed(ITEM, { item: ITEM, save: true, allowLive: true }));
});

test("chromeDescriptions skips empty and too-long descriptions", () => {
  const r = chromeDescriptions({ en: { description: "ok" }, de: { description: " " }, fr: { description: "x".repeat(16001) }, ja: {} });
  assert.deepEqual(Object.keys(r.descriptions), ["en"]);
  assert.equal(r.problems.length, 3);
});

test("paste script: valid JavaScript, carries the data, keeps fill-core intact", () => {
  const core = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "fill-core.js"), "utf8");
  const script = buildPasteScript({ de: { description: "Preis: $4.99 `x` ${y}\n- a" } }, { mode: "fill-all" });
  assert.doesNotThrow(() => new Script(script));
  assert.ok(script.includes(core), "fill-core is included unchanged");
  assert.ok(script.includes(JSON.stringify("Preis: $4.99 `x` ${y}\n- a")));
  assert.match(script, /mode: "fill-all", save: "none"/);
  assert.match(buildPasteScript({ de: { description: "d" } }, { mode: "save-each" }), /save: "wait"/);
  assert.doesNotThrow(() => new Script(buildDiagnoseScript(["de"])));
});

const WORLD = {
  ar: { description: "يحفظ PageCarry صفحتك • بنقرة واحدة" },
  ja: { description: "ページを保存します。\n• リーダーモード" },
  en: { description: "Save pages 📄🚀 • fast — “quoted”\r\nnext line" },
};

test("B0: the paste and diagnose scripts are pure ASCII, and the data round-trips exactly", () => {
  const { descriptions } = chromeDescriptions(WORLD);
  const script = buildPasteScript(descriptions);
  assert.ok(isAscii(script), "every byte must be ASCII");
  assert.ok(Buffer.from(script, "utf8").every((b) => b < 0x80));
  assert.ok(script.includes("\\ud83d\\udcc4"), "emoji as a surrogate pair escape");
  assert.ok(isAscii(buildDiagnoseScript(["ar", "ja"])));
  assert.ok(isAscii(readFillCore()));
  const data = JSON.parse(/const LISTINGS = ([\s\S]*?);\n/.exec(script)![1]!);
  assert.equal(data.ar.description, WORLD.ar.description);
  assert.equal(data.en.description, "Save pages 📄🚀 • fast — “quoted”\nnext line", "CRLF normalized");
  assert.equal(data.en.length, [...data.en.description].length);
  assert.equal(data.ja.sha, shortHash(WORLD.ja.description));
  assert.equal(JSON.parse(asciiJson("a\u2028b😀")), "a\u2028b😀");
});

test("B0: copyToClipboard sets a UTF-8 locale and reads back; a mismatch is an error", () => {
  const calls: { cmd: string; env: NodeJS.ProcessEnv }[] = [];
  let clip = "";
  const good = (cmd: string, o: { input?: string; env: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, env: o.env });
    if (cmd === "pbcopy") clip = o.input ?? "";
    return { status: 0, stdout: cmd === "pbpaste" ? clip : "" };
  };
  assert.equal(copyToClipboard("héllo", good, "darwin"), null);
  assert.deepEqual(calls.map((c) => c.cmd), ["pbcopy", "pbpaste"]);
  assert.ok(calls.every((c) => c.env.LC_ALL === "en_US.UTF-8" && c.env.PATH === process.env.PATH));
  // A clipboard that decodes UTF-8 as MacRoman: what pbcopy did without a locale.
  const macRoman = (cmd: string, o: { input?: string }) => {
    if (cmd === "pbcopy") clip = Buffer.from(o.input ?? "", "utf8").toString("latin1");
    return { status: 0, stdout: cmd === "pbpaste" ? clip : "" };
  };
  assert.match(copyToClipboard("• Reader mode", macRoman, "darwin")!, /does not hold the script/);
  assert.match(copyToClipboard("x", good, "linux")!, /only supported on macOS/);
});

test("B0: the read-back works for scripts over 1 MB (spawnSync buffer)", () => {
  const big = "x".repeat(2 * 1024 * 1024);
  const r = defaultRun("cat", { input: big, env: process.env });
  assert.equal(r.error, undefined);
  assert.equal(String(r.stdout).length, big.length);
});

test("B0: the in-page integrity check catches a damaged embedded string (fill-core in Node)", async () => {
  new Function(readFillCore())();
  const L = (globalThis as unknown as { ListingFill: { checkIntegrity(l: unknown): Promise<{ locale: string; error: string }[]>; shortHash(s: string): Promise<string> } }).ListingFill;
  const { descriptions } = chromeDescriptions(WORLD);
  assert.deepEqual(await L.checkIntegrity(descriptions), []);
  assert.equal(await L.shortHash(WORLD.ar.description), shortHash(WORLD.ar.description), "same hash in page and CLI");
  // What a MacRoman clipboard does to the text: each UTF-8 byte becomes one character.
  const garbled = Buffer.from(descriptions.ar!.description, "utf8").toString("latin1");
  const broken = { ...descriptions, ar: { ...descriptions.ar!, description: garbled } };
  const problems = await L.checkIntegrity(broken);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.error, /embedded text has \d+ characters, the listing file has \d+/);
  // Same length, different text: caught by the hash.
  const swapped = { ...descriptions, ja: { ...descriptions.ja!, description: descriptions.ja!.description.replace("保", "宝") } };
  assert.match((await L.checkIntegrity(swapped))[0]!.error, /hash/);
});

test("outDir writes a .gitignore that ignores everything", () => {
  const dir = mkdtempSync(join(tmpdir(), "ext-localize-"));
  const out = outDir(dir);
  assert.equal(readFileSync(join(out, ".gitignore"), "utf8").trim().split("\n").pop(), "*");
});

test("push chrome: writes the paste and diagnose scripts", async () => {
  const dir = listingFixture();
  const { result, out } = await quiet(() => main(["push", "chrome", "--dir", dir]));
  assert.equal(result, 0);
  const script = readFileSync(join(dir, ".localizer/out/chrome-paste.js"), "utf8");
  assert.ok(script.includes("Sitzungen speichern"));
  assert.ok(existsSync(join(dir, ".localizer/out/chrome-diagnose.js")));
  assert.match(out, /4 language\(s\): de, en, he, pt_BR/);
  assert.match(out, /Click "Save draft" yourself/);
});

test("push chrome: --auto flags without --auto, and --auto without --item, are usage errors", async () => {
  const dir = listingFixture();
  assert.equal((await quiet(() => main(["push", "chrome", "--dir", dir, "--save"]))).result, 2);
  const r = await quiet(() => main(["push", "chrome", "--dir", dir, "--auto"]));
  assert.equal(r.result, 2);
  assert.match(r.out, /EXPERIMENTAL/);
  assert.match(r.out, /needs --item/);
  assert.equal((await quiet(() => main(["push", "chrome", "--dir", dir, "--auto", "--item", "nope"]))).result, 2);
});

test("push edge: one file per locale; too short is reported", async () => {
  const dir = listingFixture();
  const { result, out } = await quiet(() => main(["push", "edge", "--dir", dir]));
  assert.equal(result, 1, "de, pt_BR and he are under 250 characters");
  assert.ok(readFileSync(join(dir, ".localizer/out/edge/en.txt"), "utf8").startsWith("TabNest saves"));
  assert.match(out, /de .* too short/);
  const entries = writeEdgeFiles({ en: { description: "x".repeat(10001) } }, mkdtempSync(join(tmpdir(), "edge-")));
  assert.match(entries[0]!.problem!, /at most 10000/);
});

// ---------------------------------------------------------------------------
// Browser tests on the local mock dashboard (skipped without Chrome or playwright-core)
// ---------------------------------------------------------------------------

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "chrome-mock");
let pwAvailable = true;
try {
  await loadPlaywright();
} catch {
  pwAvailable = false;
}
const skip = !existsSync(MAC_CHROME) ? "Google Chrome not installed" : !pwAvailable ? "playwright-core not installed" : false;

describe("mock dashboard", { skip }, () => {
  let server: Server;
  let port = 0;
  const posts: string[] = [];
  const pageUrl = (item: string, markup = "brief") =>
    `http://127.0.0.1:${port}/webstore/devconsole/test-publisher/${item}/edit?markup=${markup}&switch=keep&delay=100&persist=1`;

  before(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method === "POST") {
        posts.push(path);
        req.resume();
        req.on("end", () => {
          res.writeHead(204);
          res.end();
        });
        return;
      }
      let file: string | null = null;
      if (path.endsWith("/edit")) file = join(MOCK, "index.html");
      else if (path.endsWith("/app.js")) file = join(MOCK, "app.js");
      else if (/\/vendor\/[\w.-]+\.js$/.test(path)) file = join(MOCK, "vendor", path.split("/").pop() as string);
      if (!file || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "text/javascript" });
      res.end(readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  after(() => server.close());

  test("the paste script fills every language on the mock (aria markup, no codes)", async () => {
    const { chromium } = await loadPlaywright();
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pageUrl(ITEM, "aria"));
      const dir = listingFixture();
      await quiet(() => main(["push", "chrome", "--dir", dir]));
      await page.evaluate(readFileSync(join(dir, ".localizer/out/chrome-paste.js"), "utf8"));
      const state = await page.evaluate(() => {
        const w = window as unknown as { __listingFillReport: { verify: { ok: boolean }; unmatched: unknown[] }; __mockState: { drafts: Record<string, string>; saveClicks: number; submitClicked: boolean } };
        return { report: w.__listingFillReport, drafts: w.__mockState.drafts, saveClicks: w.__mockState.saveClicks, submit: w.__mockState.submitClicked };
      });
      assert.equal(state.report.verify.ok, true);
      assert.deepEqual(state.report.unmatched, []);
      assert.match(state.drafts.de ?? "", /Sitzungen speichern/);
      assert.match(state.drafts["pt-BR"] ?? "", /Salvar sessões/);
      assert.match(state.drafts.iw ?? "", /שומר/);
      assert.equal(state.saveClicks, 0, "the paste script leaves Save draft to the user");
      assert.equal(state.submit, false);
    } finally {
      await browser.close();
    }
  });

  test("B0: a damaged paste script fills nothing on the mock", async () => {
    const { chromium } = await loadPlaywright();
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pageUrl(ITEM, "brief"));
      const { descriptions } = chromeDescriptions({ de: { description: "Grüße • schön" } });
      const garbled = { de: { ...descriptions.de!, description: Buffer.from("Grüße • schön", "utf8").toString("latin1") } };
      await page.evaluate(buildPasteScript(garbled));
      const r = await page.evaluate(() => {
        const w = window as unknown as { __listingFillReport: { integrity: { ok: boolean }; filled: unknown[] }; __mockState: { drafts: Record<string, string> } };
        return { integrity: w.__listingFillReport.integrity.ok, filled: w.__listingFillReport.filled.length, de: w.__mockState.drafts.de };
      });
      assert.equal(r.integrity, false);
      assert.equal(r.filled, 0);
      assert.equal(r.de, "Alte Beschreibung.", "the page was not touched");
    } finally {
      await browser.close();
    }
  });

  describe("--auto over a debugging port", () => {
    let chrome: ChildProcess;
    let cdpPort = 0;

    before(async () => {
      cdpPort = 9300 + Math.floor(Math.random() * 500);
      chrome = spawn(
        MAC_CHROME,
        [
          `--user-data-dir=${mkdtempSync(join(tmpdir(), "ext-localize-chrome-"))}`,
          `--remote-debugging-port=${cdpPort}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--headless=new",
          pageUrl(ITEM),
        ],
        { stdio: "ignore" },
      );
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        const ok = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.ok).catch(() => false);
        if (ok) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    });
    after(() => {
      chrome.kill("SIGTERM");
    });

    test("saving on an item that is not a test item is refused without --allow-live", async () => {
      posts.length = 0;
      const dir = listingFixture();
      const { result, out } = await quiet(() =>
        main(["push", "chrome", "--dir", dir, "--auto", "--item", ITEM, "--browser", `port:${cdpPort}`, "--save"]),
      );
      assert.equal(result, 1);
      assert.match(out, /may be a live item/);
      assert.deepEqual(posts, []);
    });

    test("the open tab must be the named item", async () => {
      const dir = listingFixture();
      const report = await runAuto(
        { en: { description: "x" } },
        { item: OTHER, browser: `port:${cdpPort}`, url: pageUrl(ITEM), waitMs: 1500 },
      );
      assert.match(report.error ?? "", /Timed out waiting for the item page/);
      assert.ok(dir);
    });

    test("fill, Save draft, reload and read back on a test item; never Submit; Chrome stays open", async () => {
      posts.length = 0;
      const dir = listingFixture({ chrome: { testItems: [ITEM] } });
      const { result, out } = await quiet(() =>
        main(["push", "chrome", "--dir", dir, "--auto", "--item", ITEM, "--browser", `port:${cdpPort}`, "--save"]),
      );
      assert.equal(result, 0, out);
      assert.match(out, /EXPERIMENTAL/);
      assert.match(out, /After reload: every language has the new text/);
      assert.deepEqual(posts, ["/mock-save"], "exactly one save, no submit");
      const reportFile = /Report: (.*\.json)/.exec(out)?.[1] as string;
      const report = JSON.parse(readFileSync(reportFile, "utf8"));
      assert.equal(report.afterReload.ok, true);
      assert.equal(report.afterReload.rows.length, 4);
      assert.ok(!JSON.stringify(report).includes("TOKEN123"), "no request data in the report");
      const alive = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.ok).catch(() => false);
      assert.ok(alive, "the attached Chrome must stay open");
    });
  });

  test("--auto with launch (headless, temp profile): fill only, nothing saved", async () => {
    posts.length = 0;
    const dir = listingFixture();
    const { result, out } = await quiet(() =>
      main([
        "push", "chrome", "--dir", dir, "--auto", "--item", ITEM,
        "--browser", "launch", "--headless", "--profile", mkdtempSync(join(tmpdir(), "ext-localize-profile-")),
        "--url", pageUrl(ITEM),
      ]),
    );
    assert.equal(result, 0, out);
    assert.match(out, /Filled and checked 4 language/);
    assert.match(out, /No --save: nothing was saved/);
    assert.deepEqual(posts, []);
  });
});
