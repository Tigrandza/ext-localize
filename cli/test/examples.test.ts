// The WXT and Plasmo examples in examples/: their configs stay valid, and the
// manifest stub matches what each framework puts in the real manifest.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.ts";

const EX = join(import.meta.dirname, "..", "examples");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

async function check(argv: string[]): Promise<{ code: number; out: string }> {
  const log = console.log;
  let out = "";
  console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  try {
    return { code: await main(argv), out };
  } finally {
    console.log = log;
  }
}

for (const name of ["wxt", "plasmo"]) {
  test(`examples/${name}: check passes before the first build`, async () => {
    const dir = join(EX, name);
    const r = await check(["check", "--dir", dir, "--json"]);
    assert.equal(r.code, 0, r.out);
    const rep = JSON.parse(r.out);
    assert.equal(rep.errors, 0, r.out);
    assert.equal(rep.warnings, 0, r.out);
  });
}

test("examples/wxt: manifest stub matches wxt.config.ts and the popup title", () => {
  const stub = readJson(join(EX, "wxt/.localizer/manifest.json"));
  const config = readFileSync(join(EX, "wxt/wxt.config.ts"), "utf8");
  assert.match(config, new RegExp(`name: "${stub.name}"`));
  assert.match(config, new RegExp(`description: "${stub.description}"`));
  assert.match(config, new RegExp(`default_locale: "${stub.default_locale}"`));
  const html = readFileSync(join(EX, "wxt/entrypoints/popup/index.html"), "utf8");
  const title = /<title>__MSG_(\w+)__<\/title>/.exec(html);
  assert.ok(title, "the popup <title> carries the tooltip message");
  assert.ok(readJson(join(EX, "wxt/public/_locales/en/messages.json"))[title[1]!]);
});

test("examples/plasmo: manifest stub matches package.json", () => {
  const stub = readJson(join(EX, "plasmo/.localizer/manifest.json"));
  const pkg = readJson(join(EX, "plasmo/package.json"));
  assert.equal(pkg.displayName, stub.name);
  assert.equal(pkg.description, stub.description);
  assert.equal(pkg.manifest.default_locale, stub.default_locale);
});
