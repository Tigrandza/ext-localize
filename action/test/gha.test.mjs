import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { annotation, appendSummary, boolInput, escapeData, escapeMarkdown, escapeProperty, logUntrusted, oneLine, setOutputs } from "../scripts/lib/gha.mjs";
import { parseOutputs, tempDir } from "./helpers/env.mjs";

test("escapeData encodes %, CR and LF so a message cannot start a new command", () => {
  assert.equal(escapeData("50%\r\n::error::x"), "50%25%0D%0A::error::x");
});

test("escapeProperty also encodes : and ,", () => {
  assert.equal(escapeProperty("a:b,c"), "a%3Ab%2Cc");
});

test("annotation builds file, line and title properties", () => {
  assert.equal(
    annotation("error", { file: "ext/_locales/de/messages.json", line: 4, title: "ext-localize" }, "de > k: bad\nline"),
    "::error file=ext/_locales/de/messages.json,line=4,title=ext-localize::de > k: bad%0Aline",
  );
  assert.equal(annotation("warning", {}, "x"), "::warning::x");
});

test("setOutputs uses the heredoc form, so multi-line values survive", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "out");
  writeFileSync(file, "");
  setOutputs({ a: "1", b: "line1\nline2", c: undefined }, { GITHUB_OUTPUT: file });
  assert.deepEqual(parseOutputs(readFileSync(file, "utf8")), { a: "1", b: "line1\nline2", c: "" });
});

test("setOutputs and appendSummary do nothing outside Actions", () => {
  setOutputs({ a: "1" }, {});
  appendSummary("x", {});
});

test("boolInput", () => {
  assert.equal(boolInput("TRUE"), true);
  assert.equal(boolInput(" false "), false);
  assert.equal(boolInput("", true), true);
  assert.equal(boolInput(undefined), false);
  assert.throws(() => boolInput("yes"), /expected "true" or "false"/);
});

test("escapeMarkdown neutralises tables, HTML, links and mentions", () => {
  assert.equal(escapeMarkdown("a|b <img> [x](y) @team `c`\nz"), "a\\|b &lt;img&gt; \\[x\\](y) &#64;team \\`c\\` z");
});

test("oneLine removes line breaks; logUntrusted wraps text in stop-commands", () => {
  assert.equal(oneLine("a\n::error::x\r\nb"), "a ::error::x b");
  const lines = [];
  logUntrusted("x\n::error::injected", (l) => lines.push(l));
  const token = lines[0].match(/^::stop-commands::(ext-localize-[0-9a-f-]+)$/)[1];
  assert.equal(lines[1], "x\n::error::injected");
  assert.equal(lines[2], `::${token}::`);
});
