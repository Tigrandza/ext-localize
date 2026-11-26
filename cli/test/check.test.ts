import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLocale, checkProject, checkSource } from "../src/check.ts";
import { FIXTURE, makeExtension } from "./helpers.ts";

const source = {
  hello: { message: "Hello $name$!", placeholders: { name: { content: "$1" } } },
  price: { message: "Only $$5" },
  count: { message: "$1 tabs" },
};

function errors(issues: { level: string; key?: string; message: string }[]) {
  return issues.filter((i) => i.level === "error").map((i) => `${i.key}: ${i.message}`);
}

test("checkLocale: a correct translation has no issues (placeholder case may differ)", () => {
  const target = {
    hello: { message: "Hallo $NAME$!", placeholders: { name: { content: "$1" } } },
    price: { message: "Nur $$5" },
    count: { message: "$1 Tabs" },
  };
  assert.deepEqual(checkLocale(source, target, "de"), []);
});

test("checkLocale: missing key, extra key, placeholder mismatch", () => {
  const target = {
    hello: { message: "Hallo!", placeholders: { name: { content: "$1" } } },
    price: { message: "Nur 5 $" },
    extra: { message: "Extra" },
  };
  const e = errors(checkLocale(source, target, "de"));
  assert.ok(e.some((m) => m.startsWith("count: missing")));
  assert.ok(e.some((m) => m.startsWith("extra: extra key")));
  assert.ok(e.some((m) => m.startsWith("hello: missing placeholder(s) $name$")));
  const warnings = checkLocale(source, target, "de").filter((i) => i.level === "warning").map((i) => i.message);
  assert.ok(warnings.some((m) => m.includes('"$$" count differs')));
});

test("checkLocale: a different $$ count alone is a warning, not an error", () => {
  const target = { ...source, price: { message: "Nur 5 €" } };
  const issues = checkLocale(source, target, "de");
  assert.deepEqual(issues.map((i) => i.level), ["warning"]);
});

test("checkLocale: placeholders must be defined in the locale file itself", () => {
  const target = {
    hello: { message: "Hallo $name$!" },
    price: { message: "Nur $$5" },
    count: { message: "$1 Tabs" },
  };
  const e = errors(checkLocale(source, target, "de"));
  assert.deepEqual(e, ['hello: $name$ is used but not defined in "placeholders"']);
});

test("checkLocale: reserved @@ keys, bad key names, empty and non-string messages", () => {
  const target = {
    ...{ hello: source.hello, price: source.price, count: source.count },
    "@@ui_locale": { message: "x" },
    "bad-key": { message: "x" },
    empty: { message: "  " },
    nomsg: { text: "x" },
  };
  const e = errors(checkLocale(source, target, "de"));
  assert.ok(e.some((m) => m.startsWith('@@ui_locale: keys starting with "@@"')));
  assert.ok(e.some((m) => m.startsWith("bad-key: invalid key name")));
  assert.ok(e.some((m) => m.startsWith("empty: empty message")));
  assert.ok(e.some((m) => m.startsWith('nomsg: missing "message"')));
});

test("checkLocale: keys that differ only in case are duplicates", () => {
  const e = errors(checkLocale({ a: { message: "A" } }, { a: { message: "A" }, A: { message: "B" } }, "de"));
  assert.ok(e.some((m) => m.includes("duplicate")));
});

test("checkLocale: RTL locales get a warning (not an error) for Latin-only text", () => {
  const issues = checkLocale(
    { a: { message: "Save all open tabs" }, b: { message: "$1" } },
    { a: { message: "Save all open tabs" }, b: { message: "$1" } },
    "ar",
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.level, "warning");
  assert.equal(issues[0]?.key, "a");
  assert.deepEqual(checkLocale({ a: { message: "Save" } }, { a: { message: "حفظ" } }, "ar"), []);
});

test("checkLocale: the RTL check skips brand names, units, short codes and keep terms", () => {
  const src = {
    brand: { message: "PageCarry" },
    a4: { message: "A4" },
    size: { message: "≈ $SIZE$ KB", placeholders: { size: { content: "$1" } } },
    ver: { message: "v1.x" },
    kept: { message: "Open in TabNest Pro" },
    other: { message: "Translate me please" },
  };
  const tgt = {
    brand: { message: "PageCarry" },
    a4: { message: "A4" },
    size: { message: "≈ $SIZE$ KB", placeholders: { size: { content: "$1" } } },
    ver: { message: "v1.x" },
    kept: { message: "TabNest Pro" },
    other: { message: "Different but Latin text" },
  };
  const issues = checkLocale(src, tgt, "ar", { keep: ["TabNest", "Pro"] });
  assert.deepEqual(issues.map((i) => i.key), ["other"]);
});

test("checkSource: warns on unused placeholders and stray $", () => {
  const issues = checkSource({ a: { message: "Cost $ 5", placeholders: { n: { content: "$1" } } } }, "en");
  assert.equal(issues.filter((i) => i.level === "warning").length, 2);
});

test("checkProject: the sample fixture is clean", () => {
  const r = checkProject(FIXTURE);
  assert.equal(r.errors, 0);
  assert.equal(r.warnings, 0);
  assert.equal(r.defaultLocale, "en");
});

test("checkProject: a locale with broken JSON is an error", () => {
  const dir = makeExtension({
    "manifest.json": { manifest_version: 3, name: "__MSG_name__", version: "1", default_locale: "en" },
    "_locales/en/messages.json": { name: { message: "Name" } },
    "_locales/de/messages.json": '{ "name": { "message": "Name", } }',
  });
  const r = checkProject(dir);
  assert.equal(r.errors, 1);
  assert.match(r.issues[0]!.message, /invalid JSON.*Chrome drops this locale/);
});

test("checkProject: missing __MSG_ key, folder without messages.json, unknown locale folder", () => {
  const dir = makeExtension({
    "manifest.json": '{ // comment\n "manifest_version": 3, "name": "__MSG_extName__", "version": "1", "default_locale": "en" }',
    "_locales/en/messages.json": { other: { message: "x" } },
    "_locales/fr/.keep": "",
    "_locales/xx/messages.json": { other: { message: "x" } },
  });
  const r = checkProject(dir);
  const msgs = r.issues.map((i) => `${i.level} ${i.locale}: ${i.message}`);
  assert.ok(msgs.some((m) => m.includes("__MSG_extName__")));
  assert.ok(msgs.some((m) => m.startsWith("error fr: folder has no messages.json")));
  assert.ok(msgs.some((m) => m.startsWith("warning xx:")));
});

test("checkProject: no default_locale while _locales exists is an error", () => {
  const dir = makeExtension({
    "manifest.json": { manifest_version: 3, name: "x", version: "1" },
    "_locales/en/messages.json": { a: { message: "x" } },
  });
  assert.equal(checkProject(dir).errors, 1);
});

test("checkProject: store length limits are warnings", () => {
  const dir = makeExtension({
    "manifest.json": { manifest_version: 3, name: "__MSG_n__", version: "1", default_locale: "en" },
    "_locales/en/messages.json": { n: { message: "Short" } },
    "_locales/de/messages.json": { n: { message: "x".repeat(80) } },
  });
  const r = checkProject(dir);
  assert.equal(r.errors, 0);
  assert.equal(r.warnings, 1);
});
