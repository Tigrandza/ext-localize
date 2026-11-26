import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BODY_LIMIT,
  buildTranslateArgs,
  codeBlock,
  commitPaths,
  failedCount,
  parseStores,
  parseTranslateJson,
  patternToRegExp,
  renderRun,
  renderTranslateBody,
} from "../scripts/lib/translate.mjs";
import { translateOutcome } from "../scripts/main.mjs";

test("buildTranslateArgs: full set, always --json, --flag=value form", () => {
  assert.deepEqual(buildTranslateArgs({ dir: "/w/ext", provider: "deepl", to: "de, fr,pt-BR", model: "", formality: "more" }), [
    "translate", "--dir=/w/ext", "--json", "--provider=deepl", "--to=de,fr,pt-BR", "--formality=more",
  ]);
  assert.deepEqual(buildTranslateArgs({ dir: "/w", provider: "ollama", model: "qwen3:8b" }), [
    "translate", "--dir=/w", "--json", "--provider=ollama", "--model=qwen3:8b",
  ]);
});

test("buildTranslateArgs: listing and store", () => {
  assert.deepEqual(buildTranslateArgs({ dir: "/w", provider: "deepl", listing: true, store: "chrome,firefox" }), [
    "translate", "--dir=/w", "--json", "--listing", "--provider=deepl", "--store=chrome,firefox",
  ]);
  // --store only matters for the listing.
  assert.deepEqual(buildTranslateArgs({ dir: "/w", provider: "deepl", store: "chrome" }), ["translate", "--dir=/w", "--json", "--provider=deepl"]);
});

test("buildTranslateArgs: provider may come from the config file", () => {
  assert.deepEqual(buildTranslateArgs({ dir: "/w", provider: "" }), ["translate", "--dir=/w", "--json"]);
  assert.deepEqual(buildTranslateArgs({ dir: "/w", dryRun: true }), ["translate", "--dir=/w", "--json", "--dry-run"]);
});

test("buildTranslateArgs: rejects bad values instead of passing them on", () => {
  assert.throws(() => buildTranslateArgs({ dir: "/w", provider: "google" }), /not one of/);
  assert.throws(() => buildTranslateArgs({ dir: "/w", provider: "deepl", to: "de;rm -rf /" }), /not a locale code/);
  assert.throws(() => buildTranslateArgs({ dir: "/w", provider: "openai", model: "gpt x" }), /not allowed/);
  assert.throws(() => buildTranslateArgs({ dir: "/w", provider: "deepl", formality: "polite" }), /not one of/);
  assert.throws(() => buildTranslateArgs({ dir: "/w", provider: "deepl", to: "--force" }), /not a locale code/);
  assert.throws(() => buildTranslateArgs({ dir: "/w", provider: "openai", model: "--force" }), /not allowed/);
  assert.throws(() => parseStores("chrome,safari"), /"safari" is not one of/);
});

test("parseTranslateJson accepts results and error results, nothing else", () => {
  assert.equal(parseTranslateJson('{"command":"translate","exitCode":2,"ok":false,"error":"x"}').error, "x");
  assert.equal(parseTranslateJson('{"command":"check"}'), null);
  assert.equal(parseTranslateJson("not json"), null);
});

test("patternToRegExp turns <placeholders> into one path segment", () => {
  const re = patternToRegExp("_locales/<locale>/messages.json");
  assert.ok(re.test("_locales/pt_BR/messages.json"));
  assert.ok(!re.test("_locales/a/b/messages.json"));
  assert.ok(!re.test("x_locales/de/messages.json"));
  assert.ok(patternToRegExp(".localizer/state.json").test(".localizer/state.json"));
  assert.ok(!patternToRegExp(".localizer/state.json").test(".localizer/stateXjson"));
});

const MAY = ["_locales/<locale>/messages.json", ".localizer/state.json"];

test("commitPaths: the union of filesWritten, checked against mayWrite", () => {
  const runs = [
    { json: { filesWritten: [".localizer/state.json", "_locales/de/messages.json"], mayWrite: MAY } },
    { json: { filesWritten: [".localizer/state.json", "listing/de.json"], mayWrite: ["listing/<locale>.json", ".localizer/state.json"] } },
    { json: null },
  ];
  assert.deepEqual(commitPaths(runs), [".localizer/state.json", "_locales/de/messages.json", "listing/de.json"]);
  assert.deepEqual(commitPaths([{ json: { filesWritten: [], mayWrite: MAY } }]), []);
});

test("commitPaths refuses paths outside the CLI's own list or outside the folder", () => {
  for (const bad of ["manifest.json", "../x/_locales/de/messages.json", "/etc/_locales/de/messages.json", "_locales/../../de/messages.json", ".git/config"]) {
    assert.throws(() => commitPaths([{ json: { filesWritten: [bad], mayWrite: [...MAY, "<x>/config", "<a>/<b>/<c>/messages.json"] } }]), /not in its own list/, bad);
  }
});

test("codeBlock uses a longer fence when the text contains ```", () => {
  assert.equal(codeBlock("a"), "```text\na\n```");
  assert.equal(codeBlock("x ``` y"), "````text\nx ``` y\n````");
});

const RESULT = {
  command: "translate",
  target: "messages",
  dryRun: false,
  provider: "deepl",
  exitCode: 1,
  ok: false,
  noTargets: false,
  stopped: null,
  locales: [
    { locale: "de", new: 2, changed: 1, invalid: 0, forced: 0, removed: 1, kept: 22, adopted: 0, manual: 1, translated: 2, failed: 1, requests: 1, skipped: null, failedKeys: [{ key: "actionTitle", error: "marker 0 ($count$) is missing" }], written: ["_locales/de/messages.json"] },
    { locale: "am", new: 25, changed: 0, invalid: 0, forced: 0, removed: 0, kept: 0, adopted: 0, manual: 0, translated: 0, failed: 0, requests: 0, skipped: "DeepL does not support am", failedKeys: [], written: [] },
  ],
  totals: { strings: 3, requests: 1, characters: 120, failed: 1 },
  filesWritten: [".localizer/state.json", "_locales/de/messages.json"],
  mayWrite: MAY,
  check: { errors: 0, warnings: 2, stale: 0 },
};

test("renderRun: table, skipped note, failed keys and check counts", () => {
  const md = renderRun({ target: "messages", exitCode: 1, json: RESULT, stderr: "" });
  assert.match(md, /^### Messages/);
  assert.match(md, /\| de \| 2 \| 1 \| 0 \| 1 \| 22 \| 2 \| 1 \| 1 edited by hand \(kept\) \|/);
  assert.match(md, /\| am \| 25 .* skipped: DeepL does not support am \|/);
  assert.match(md, /- de > actionTitle: marker 0 \(\$count\$\) is missing/);
  assert.match(md, /found 0 error\(s\), 2 warning\(s\) and 0 stale/);
});

test("renderRun: no targets, error result, stopped, no result", () => {
  assert.match(renderRun({ target: "messages", exitCode: 3, json: { ...RESULT, noTargets: true, locales: [] } }), /Nothing to do: there are no target locales/);
  assert.match(renderRun({ target: "listing", exitCode: 1, json: { command: "translate", exitCode: 1, ok: false, error: "DEEPL_API_KEY is not set" } }), /^### Store listing[\s\S]*\*\*Failed\*\* \(exit code 1\): DEEPL\\_API\\_KEY is not set/);
  assert.match(renderRun({ target: "messages", exitCode: 1, json: { ...RESULT, stopped: "quota exceeded" } }), /Stopped early:\*\* quota exceeded/);
  assert.match(renderRun({ target: "messages", exitCode: 139, json: null, stderr: "Segmentation fault" }), /exit code 139[\s\S]*Segmentation fault/);
});

test("renderTranslateBody joins runs and stays under the size limit", () => {
  const body = renderTranslateBody({ runs: [{ target: "messages", exitCode: 1, json: RESULT }], provider: "deepl", dirLabel: "ext", runUrl: "https://x/run/1" });
  assert.match(body, /provider: deepl\) for ext/);
  assert.match(body, /\[this workflow run\]\(https:\/\/x\/run\/1\)/);
  const many = { ...RESULT, locales: [{ ...RESULT.locales[0], failedKeys: Array.from({ length: 5000 }, (_, i) => ({ key: `k${i}`, error: "e".repeat(50) })) }] };
  const long = renderTranslateBody({ runs: [{ target: "messages", exitCode: 1, json: many }], provider: "", dirLabel: "." });
  assert.ok(long.length <= BODY_LIMIT + 100);
  assert.match(long, /and 4950 more/);
  assert.match(long, /provider: from config/);
});

test("failedCount and translateOutcome", () => {
  const ok = { exitCode: 0, json: { totals: { failed: 0 } }, hardError: false };
  const partial = { exitCode: 1, json: RESULT, hardError: false };
  const none = { exitCode: 3, json: { noTargets: true }, hardError: false };
  const broken = { exitCode: 2, json: { error: "x" }, hardError: true };
  assert.equal(failedCount([ok, partial]), 1);
  assert.equal(translateOutcome([ok]), "pass");
  assert.equal(translateOutcome([ok, partial]), "partial");
  assert.equal(translateOutcome([none]), "no-targets");
  assert.equal(translateOutcome([none, ok]), "pass");
  assert.equal(translateOutcome([ok, broken]), "error");
});
