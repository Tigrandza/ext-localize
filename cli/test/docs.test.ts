// Keeps the README, the --help text and the code in step, so the public docs
// do not drift from what the CLI really accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cliSource = readFileSync(join(root, "src/cli.ts"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; engines: { node: string } };

/** Every option name declared in a parseArgs({ options: { ... } }) call in cli.ts. */
function declaredOptions(src: string): string[] {
  const names = new Set<string>();
  for (const call of src.matchAll(/parseArgs\(\{([\s\S]*?)\n\s*\}\);/g)) {
    const body = call[1]!;
    const start = body.indexOf("options:");
    if (start < 0) continue;
    // Take the balanced { ... } after "options:".
    let depth = 0;
    let end = -1;
    for (let i = body.indexOf("{", start); i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const block = body.slice(body.indexOf("{", start) + 1, end);
    for (const m of block.matchAll(/"?([a-z][a-z-]*)"?\s*:\s*\{\s*type:/g)) names.add(m[1]!);
  }
  return [...names].sort();
}

async function helpText(): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    assert.equal(await main(["--help"]), 0);
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

const mentions = (text: string, option: string) => new RegExp(`--${option}(?![a-z-])`).test(text);

test("the option list is read from cli.ts", () => {
  const options = declaredOptions(cliSource);
  // A few from each command, so a broken parser cannot pass with an empty list.
  for (const o of ["provider", "dry-run", "strict", "stale", "send", "default-locale", "copy", "allow-live", "print", "listing-dir"]) {
    assert.ok(options.includes(o), `parser missed --${o}`);
  }
  assert.ok(options.length >= 35, `only ${options.length} options found`);
});

test("every option is documented in --help", async () => {
  const help = await helpText();
  const missing = declaredOptions(cliSource).filter((o) => !mentions(help, o));
  assert.deepEqual(missing, [], `add these to HELP in src/cli.ts: ${missing.map((o) => "--" + o).join(", ")}`);
});

test("every option is documented in README.md", () => {
  const missing = declaredOptions(cliSource).filter((o) => !mentions(readme, o));
  assert.deepEqual(missing, [], `add these to cli/README.md: ${missing.map((o) => "--" + o).join(", ")}`);
});

test("the README does not say the package is unpublished", () => {
  for (const stale of [/not published/i, /until the package is published/i, /only been run on Node \d+/i]) {
    assert.doesNotMatch(readme, stale);
  }
});

test("the README states the same Node range as package.json", () => {
  const min = /^>=(\d+)$/.exec(pkg.engines.node)?.[1];
  assert.ok(min, `engines.node is ${pkg.engines.node}`);
  assert.match(readme, new RegExp(`Node ${min} or newer|Node ${min}\\+`));
});

test("the CHANGELOG has an entry for the package version", () => {
  assert.match(changelog, new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")} \\(\\d{4}-\\d{2}-\\d{2}\\)`, "m"));
});
