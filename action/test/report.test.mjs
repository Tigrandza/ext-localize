import { test } from "node:test";
import assert from "node:assert/strict";
import { ANNOTATION_LIMIT, buildAnnotations, decide, issueFile, renderCheckSummary, staleFlag } from "../scripts/lib/report.mjs";

const staleCheck = (o = {}) => ({ mode: "error", status: "ok", stale: 0, untracked: 0, note: "No stale strings.", ...o });
const clean = { defaultLocale: "en", locales: ["de", "en"], issues: [], errors: 0, warnings: 0, stale: 0, staleCheck: staleCheck() };
const staleIssue = (locale, key, level = "error") => ({ level, kind: "stale", locale, key, message: "source changed after translation (by deepl)", file: `_locales/${locale}/messages.json`, line: 3 });

test("staleFlag maps the Action input to the CLI flag", () => {
  assert.equal(staleFlag("fail"), "--stale=error");
  assert.equal(staleFlag("warn"), "--stale=warning");
  assert.equal(staleFlag("ignore"), "--stale=off");
  assert.throws(() => staleFlag("maybe"));
});

test("decide: errors fail and stale errors are named apart", () => {
  assert.deepEqual(decide({ report: clean, strict: false }), { failed: false, reasons: [] });
  assert.deepEqual(decide({ report: { ...clean, errors: 2 }, strict: false }), { failed: true, reasons: ["2 error(s)"] });
  const report = { ...clean, errors: 3, stale: 2, issues: [staleIssue("de", "a"), staleIssue("fr", "a")], staleCheck: staleCheck({ stale: 2 }) };
  assert.deepEqual(decide({ report, strict: false }).reasons, ["1 error(s)", "2 stale string(s)"]);
});

test("decide: stale as warnings fails only with strict", () => {
  const report = { ...clean, warnings: 1, stale: 1, issues: [staleIssue("de", "a", "warning")], staleCheck: staleCheck({ mode: "warning", stale: 1 }) };
  assert.equal(decide({ report, strict: false }).failed, false);
  assert.deepEqual(decide({ report, strict: true }).reasons, ["1 warning(s) (strict is on)"]);
});

test("issueFile joins the extension folder and the CLI's file path", () => {
  assert.equal(issueFile("ext", { file: "_locales/de/messages.json" }), "ext/_locales/de/messages.json");
  assert.equal(issueFile(".", { file: "manifest.json" }), "manifest.json");
  assert.equal(issueFile("ext", {}), undefined);
});

test("buildAnnotations uses the CLI's file and line, and caps per level", () => {
  const issues = [
    { level: "error", locale: "de", key: "b", message: "placeholder differs", file: "_locales/de/messages.json", line: 5 },
    { level: "warning", locale: null, message: "manifest name too long", file: "manifest.json", line: 4 },
    staleIssue("de", "a", "warning"),
    { level: "error", locale: "de", message: "does not parse" },
  ];
  const a = buildAnnotations({ report: { ...clean, issues }, strict: false, dirLabel: "ext" });
  assert.deepEqual(a.lines, [
    "::error file=ext/_locales/de/messages.json,line=5,title=ext-localize::de > b: placeholder differs",
    "::warning file=ext/manifest.json,line=4,title=ext-localize::manifest name too long",
    "::warning file=ext/_locales/de/messages.json,line=3,title=ext-localize::de > a: source changed after translation (by deepl)",
    "::error title=ext-localize::de: does not parse",
  ]);
  const s = buildAnnotations({ report: { ...clean, issues }, strict: true, dirLabel: "." });
  assert.ok(s.lines.every((l) => l.startsWith("::error")));
  const many = Array.from({ length: 15 }, (_, i) => ({ level: "error", locale: "de", key: `k${i}`, message: "m" }));
  const c = buildAnnotations({ report: { ...clean, issues: many }, strict: false, dirLabel: "." });
  assert.equal(c.lines.length, ANNOTATION_LIMIT);
  assert.equal(c.dropped, 5);
});

test("renderCheckSummary escapes repo text and groups stale keys", () => {
  const issues = [
    { level: "error", locale: "de", key: "x|y", message: "<script> | @all", file: "_locales/de/messages.json", line: 7 },
    staleIssue("de", "a"),
    staleIssue("fr", "b"),
  ];
  const report = { ...clean, errors: 3, stale: 2, issues, staleCheck: staleCheck({ stale: 2 }) };
  const decision = decide({ report, strict: false });
  const md = renderCheckSummary({ report, strict: false, decision, dirLabel: "ext" });
  assert.match(md, /^## ❌ ext-localize check/);
  assert.match(md, /\| 3 \| 0 \| 2 \|/);
  assert.match(md, /\*\*Failed:\*\* 1 error\(s\), 2 stale string\(s\)\./);
  assert.match(md, /\| error \| \\_locales\/de\/messages\.json:7 \| x\\\|y \| &lt;script&gt; \\\| &#64;all \|/);
  assert.doesNotMatch(md, /<script>/);
  assert.match(md, /\| de \| a \|/);
  assert.match(md, /\| fr \| b \|/);
});

test("renderCheckSummary shows the CLI note when stale was not checked, and 'off' when ignored", () => {
  const noState = { ...clean, staleCheck: staleCheck({ status: "no-state", note: "No .localizer/state.json, so stale strings were not checked." }) };
  const md = renderCheckSummary({ report: noState, strict: false, decision: { failed: false, reasons: [] }, dirLabel: "." });
  assert.match(md, /^## ✅/);
  assert.match(md, /not checked/);
  assert.match(md, /No \.localizer\/state\.json/);
  const off = { ...clean, staleCheck: staleCheck({ mode: "off", status: "off", note: "" }) };
  assert.match(renderCheckSummary({ report: off, strict: false, decision: { failed: false, reasons: [] }, dirLabel: "." }), /\| 0 \| 0 \| off \|/);
  const untracked = { ...clean, staleCheck: staleCheck({ untracked: 4 }) };
  assert.match(renderCheckSummary({ report: untracked, strict: false, decision: { failed: false, reasons: [] }, dirLabel: "." }), /4 translated string\(s\) have no entry/);
});
