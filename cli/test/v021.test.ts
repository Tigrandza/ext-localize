// Fixes and features from the PageCarry field report (0.2.1).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { checkLocale, checkProject } from "../src/check.ts";
import { main } from "../src/cli.ts";
import { loadProject } from "../src/messages.ts";
import { pluralFamilies } from "../src/plurals.ts";
import { loadState } from "../src/state.ts";
import { translateProject } from "../src/translate.ts";
import { zipLocales } from "../src/zip.ts";
import { MockProvider, copyFixture, makeExtension } from "./helpers.ts";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const log = console.log;
  const err = console.error;
  let stdout = "";
  let stderr = "";
  console.log = (...a: unknown[]) => void (stdout += a.join(" ") + "\n");
  console.error = (...a: unknown[]) => void (stderr += a.join(" ") + "\n");
  try {
    return { code: await main(argv), stdout, stderr };
  } finally {
    console.log = log;
    console.error = err;
  }
}

// ---------------------------------------------------------------------------
// B1: CLDR plural families
// ---------------------------------------------------------------------------

function pluralExtension() {
  return makeExtension({
    "manifest.json": { manifest_version: 3, name: "X", version: "1", default_locale: "en" },
    "_locales/en/messages.json": {
      files_one: { message: "$1 file" },
      files_other: { message: "$1 files" },
      title: { message: "Title" },
    },
    // Russian: one, few, many, other
    "_locales/ru/messages.json": {
      files_one: { message: "$1 файл" },
      files_few: { message: "$1 файла" },
      files_many: { message: "$1 файлов" },
      files_other: { message: "$1 файла" },
      title: { message: "Заголовок" },
    },
    // Japanese: only other
    "_locales/ja/messages.json": { files_other: { message: "$1 ファイル" }, title: { message: "タイトル" } },
    // German: one, other; a "few" form is not used by German
    "_locales/de/messages.json": {
      files_one: { message: "$1 Datei" },
      files_other: { message: "$1 Dateien" },
      files_few: { message: "$1 Dateien" },
      title: { message: "Titel" },
    },
  });
}

test("B1: plural families are found only with an _other key and one more form", () => {
  assert.deepEqual([...pluralFamilies(["a_one", "a_other", "b_other", "c_one", "x"])], ["a"]);
});

test("B1: check accepts each locale's own plural forms", () => {
  const dir = pluralExtension();
  const r = checkProject(dir);
  assert.equal(r.errors, 0, JSON.stringify(r.issues, null, 1));
  const warn = r.issues.filter((i) => i.level === "warning");
  assert.deepEqual(warn.map((i) => `${i.locale} ${i.key}`), ["de files_few"]);
  assert.match(warn[0]!.message, /not used in de/);
});

test("B1: a missing form the language uses is reported; a broken extra form is an error", () => {
  const src = { n_one: { message: "$1 item" }, n_other: { message: "$1 items" } };
  const ru = checkLocale(src, { n_one: { message: "$1 x" }, n_other: { message: "$1 y" }, n_few: { message: "no placeholder" } }, "ru");
  assert.ok(ru.some((i) => i.level === "warning" && i.key === "n_many" && /missing/.test(i.message)));
  assert.ok(ru.some((i) => i.level === "error" && i.key === "n_few" && /compared with n_other/.test(i.message)));
  const ja = checkLocale(src, { n_other: { message: "$1 z" } }, "ja");
  assert.deepEqual(ja, []);
  const de = checkLocale(src, { n_other: { message: "$1 z" } }, "de");
  assert.deepEqual(de.map((i) => i.level + " " + i.key), ["error n_one"], "German uses one: still missing");
});

test("B1: translate keeps a locale's extra plural forms and does not add forms it does not use", async () => {
  const dir = pluralExtension();
  const provider = new MockProvider();
  await translateProject(loadProject(dir), loadState(dir, "en"), { provider, targets: ["ru", "ja"], force: true });
  const ru = readJson(join(dir, "_locales/ru/messages.json"));
  assert.deepEqual(Object.keys(ru), ["files_one", "files_other", "files_few", "files_many", "title"]);
  assert.equal(ru.files_few.message, "$1 файла", "extra form kept as is");
  const ja = readJson(join(dir, "_locales/ja/messages.json"));
  assert.deepEqual(Object.keys(ja), ["files_other", "title"]);
  const sentJa = provider.calls.filter((c) => c.targetLocale === "ja").flatMap((c) => c.items.map((i) => i.key));
  assert.ok(!sentJa.includes("files_one"));
});

// ---------------------------------------------------------------------------
// B2 / B3: listing.dir
// ---------------------------------------------------------------------------

test("B2: an absolute listing.dir is used", async () => {
  const dir = copyFixture();
  const outside = mkdtempSync(join(tmpdir(), "ext-localize-listing-"));
  writeFileSync(join(outside, "en.json"), JSON.stringify({ description: "Long text." }));
  writeFileSync(join(outside, "de.json"), "{bad");
  writeFileSync(join(dir, ".localizer/config.json"), JSON.stringify({ listing: { dir: outside } }));
  const r = await capture(["check", "--dir", dir, "--json"]);
  const bad = JSON.parse(r.stdout).issues.find((i: { locale: string }) => i.locale === "de");
  assert.ok(bad, "the broken de.json in the absolute folder is seen");
  assert.equal(r.code, 1);
});

test("B2: a listing.dir that does not exist is an error (exit 2), not ignored", async () => {
  const dir = copyFixture();
  writeFileSync(join(dir, ".localizer/config.json"), JSON.stringify({ listing: { dir: "/no/such/folder" } }));
  const r = await capture(["check", "--dir", dir]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /listing folder not found: \/no\/such\/folder/);
  const flag = await capture(["push", "chrome", "--dir", dir, "--listing-dir", "/nope"]);
  assert.equal(flag.code, 2);
});

test("B3: messages show the configured listing path, matching the file field", async () => {
  const root = mkdtempSync(join(tmpdir(), "ext-localize-repo-"));
  const dir = join(root, "ext");
  mkdirSync(join(root, "store", "listing"), { recursive: true });
  const ext = copyFixture();
  mkdirSync(dir);
  for (const f of ["manifest.json", "_locales", ".localizer"]) {
    // copy without the fixture's own listing folder
    await import("node:fs").then((fs) => fs.cpSync(join(ext, f), join(dir, f), { recursive: true }));
  }
  writeFileSync(join(dir, ".localizer/config.json"), JSON.stringify({ listing: { dir: "../store/listing" } }));
  writeFileSync(join(root, "store/listing/en.json"), JSON.stringify({ description: "Text." }));
  writeFileSync(join(root, "store/listing/de.json"), "{bad");
  const r = await capture(["check", "--dir", dir, "--json"]);
  const bad = JSON.parse(r.stdout).issues.find((i: { locale: string }) => i.locale === "de");
  assert.equal(bad.file, "../store/listing/de.json");
  assert.match(bad.message, /^listing: \.\.\/store\/listing\/de\.json: invalid JSON/);
});

// ---------------------------------------------------------------------------
// B4, C2
// ---------------------------------------------------------------------------

test("B4: nb is not called rejected; C2: check ends with OK or FAILED", async () => {
  const dir = copyFixture();
  mkdirSync(join(dir, "_locales/nb"));
  writeFileSync(join(dir, "_locales/nb/messages.json"), readFileSync(join(dir, "_locales/en/messages.json")));
  const r = await capture(["check", "--dir", dir]);
  assert.match(r.stdout, /"nb" is not in the Chrome Web Store locale list, so the store will not offer it; the Chrome runtime may still use it/);
  assert.ok(!/ignored or rejected/.test(r.stdout));
  assert.equal(r.stdout.trim().split("\n").pop(), "OK");
  assert.equal((await capture(["check", "--dir", dir, "--strict"])).stdout.trim().split("\n").pop(), "FAILED (0 error(s), 1 warning(s) with --strict)");
});

// ---------------------------------------------------------------------------
// M1: --config and --listing-dir (WXT / Plasmo)
// ---------------------------------------------------------------------------

test("M1: --config keeps state, glossary and out/ next to the config file", async () => {
  const repo = mkdtempSync(join(tmpdir(), "ext-localize-wxt-"));
  const build = join(repo, ".output", "chrome-mv3");
  const fixture = copyFixture();
  await import("node:fs").then((fs) => {
    fs.cpSync(fixture, build, { recursive: true });
    fs.rmSync(join(build, ".localizer"), { recursive: true });
    fs.mkdirSync(join(repo, ".localizer"));
    fs.cpSync(join(fixture, ".localizer/glossary.json"), join(repo, ".localizer/glossary.json"));
    fs.renameSync(join(build, "listing"), join(repo, "listing"));
  });
  writeFileSync(join(repo, ".localizer/config.json"), JSON.stringify({ listing: { dir: "listing" }, stores: ["chrome"] }));
  const cfg = join(repo, ".localizer/config.json");

  const dry = await capture(["translate", "--dir", build, "--config", cfg, "--to", "de", "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stderr);
  const out = JSON.parse(dry.stdout);
  assert.deepEqual(out.mayWrite, ["_locales/<locale>/messages.json", "../../.localizer/state.json"]);
  const listing = JSON.parse((await capture(["translate", "--listing", "--dir", build, "--config", cfg, "--to", "de", "--dry-run", "--json"])).stdout);
  assert.deepEqual(listing.mayWrite, ["../../listing/<locale>.json", "../../.localizer/state.json"], "listing.dir resolves from the repo, not the build");

  const push = await capture(["push", "chrome", "--dir", build, "--config", cfg]);
  assert.equal(push.code, 0, push.stderr);
  assert.ok(existsSync(join(repo, ".localizer/out/chrome-paste.js")));
  assert.ok(!existsSync(join(build, ".localizer")), "nothing written into the build folder");

  const flag = await capture(["check", "--dir", build, "--listing-dir", join(repo, "listing"), "--json"]);
  assert.equal(flag.code, 0, flag.stdout);
  const missing = await capture(["check", "--dir", build, "--config", join(repo, "nope.json")]);
  assert.equal(missing.code, 2);
});

// ---------------------------------------------------------------------------
// M2: listing import
// ---------------------------------------------------------------------------

test("M2: listing import turns <locale>.txt files into listing JSON", async () => {
  const dir = copyFixture();
  const descs = mkdtempSync(join(tmpdir(), "ext-localize-desc-"));
  writeFileSync(join(descs, "desc-de.txt"), "Deutscher Text.\r\n\r\n- Punkt\n");
  writeFileSync(join(descs, "desc-pt-BR.txt"), "Texto.");
  writeFileSync(join(descs, "desc-xx.txt"), "?");
  writeFileSync(join(descs, "desc-en.txt"), "English replacement");
  mkdirSync(join(dir, "_locales/de"));
  writeFileSync(join(dir, "_locales/de/messages.json"), JSON.stringify({ extName: { message: "TabNest DE" }, extDescription: { message: "Kurz." } }));
  const r = await capture(["listing", "import", join(descs, "desc-{locale}.txt"), "--dir", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readJson(join(dir, "listing/de.json")), { name: "TabNest DE", summary: "Kurz.", description: "Deutscher Text.\n\n- Punkt" });
  assert.deepEqual(readJson(join(dir, "listing/pt_BR.json")), { description: "Texto." });
  assert.match(r.stdout, /pt_BR\s+written\s+no name, no summary/);
  assert.match(r.stdout, /xx\s+skipped\s+not a Chrome locale code/);
  assert.match(r.stdout, /en\s+skipped\s+en\.json exists/);
  assert.ok(Array.isArray(readJson(join(dir, "listing/en.json")).description), "source not overwritten without --force");
  assert.equal((await capture(["listing", "import", join(descs, "{locale}/x.txt"), "--dir", dir])).code, 2);
});

// ---------------------------------------------------------------------------
// M3: --listing-only, M4: --zip
// ---------------------------------------------------------------------------

test("M3: check --listing-only ignores _locales problems", async () => {
  const dir = copyFixture();
  mkdirSync(join(dir, "_locales/de"));
  writeFileSync(join(dir, "_locales/de/messages.json"), JSON.stringify({ extName: { message: "X" } }));
  writeFileSync(join(dir, "listing/de.json"), JSON.stringify({ name: "X", summary: "", description: "d" }));
  const all = JSON.parse((await capture(["check", "--dir", dir, "--json"])).stdout);
  assert.ok(all.issues.some((i: { file: string }) => i.file === "_locales/de/messages.json"));
  const only = await capture(["check", "--dir", dir, "--json", "--listing-only"]);
  const rep = JSON.parse(only.stdout);
  assert.ok(rep.issues.length > 0);
  assert.ok(rep.issues.every((i: { file: string }) => i.file.startsWith("listing/")), JSON.stringify(rep.issues));
  assert.equal(rep.errors, rep.issues.filter((i: { level: string }) => i.level === "error").length);
});

/** A tiny stored (uncompressed) zip. */
function makeZip(path: string, names: string[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const data = Buffer.from("{}");
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, cd, end]));
}

test("M4: --zip compares listing files with the package's _locales", async () => {
  const dir = copyFixture();
  writeFileSync(join(dir, "listing/de.json"), JSON.stringify({ name: "TabNest", summary: "s", description: "d" }));
  const zip = join(mkdtempSync(join(tmpdir(), "ext-localize-zip-")), "pkg.zip");
  makeZip(zip, ["manifest.json", "_locales/en/messages.json", "_locales/fr/messages.json", "_locales/fr/", "_locales/nb/messages.json"]);
  assert.deepEqual(zipLocales(zip), ["en", "fr", "nb"]);
  const r = JSON.parse((await capture(["check", "--dir", dir, "--json", "--zip", zip])).stdout);
  const msgs = r.issues.map((i: { locale: string; message: string }) => `${i.locale}: ${i.message}`);
  assert.ok(msgs.some((m: string) => m.startsWith("de: listing: the package") && m.includes("has no _locales/de")), msgs.join("\n"));
  assert.ok(msgs.some((m: string) => m.startsWith("fr: listing: the package has _locales/fr but there is no listing/fr.json")));
  assert.ok(!msgs.some((m: string) => m.includes("listing/nb.json")), "nb cannot have a listing file, so no advice to add one");
  assert.equal(r.warnings, r.issues.filter((i: { level: string }) => i.level === "warning").length);
  const push = await capture(["push", "chrome", "--dir", dir, "--zip", zip]);
  assert.match(push.stdout, /warn {3}de: listing: the package/);
  writeFileSync(join(dir, "bad.zip"), "not a zip");
  assert.equal((await capture(["check", "--dir", dir, "--zip", join(dir, "bad.zip")])).code, 2);
});
