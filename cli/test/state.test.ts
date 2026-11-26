import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessagesFile } from "../src/messages.ts";
import { applyPlan, hashSource, hashTarget, planLocale, type LocaleState } from "../src/state.ts";

const source: MessagesFile = {
  a: { message: "Apple", description: "fruit" },
  b: { message: "Banana $n$", placeholders: { n: { content: "$1" } } },
  c: { message: "Cherry" },
};

function stateFor(src: MessagesFile, target: Record<string, { message: string }>): LocaleState {
  const messages: LocaleState["messages"] = {};
  for (const k of Object.keys(target)) {
    if (src[k]) messages[k] = { sourceHash: hashSource(src[k]), targetHash: hashTarget(target[k]!.message), by: "mock" };
  }
  return { messages };
}

test("hashSource ignores the description but not placeholders", () => {
  assert.equal(hashSource({ message: "x", description: "one" }), hashSource({ message: "x", description: "two" }));
  assert.notEqual(
    hashSource({ message: "$n$", placeholders: { n: { content: "$1" } } }),
    hashSource({ message: "$n$", placeholders: { n: { content: "$2" } } }),
  );
  // Placeholder name case and order do not matter.
  assert.equal(
    hashSource({ message: "$a$$b$", placeholders: { A: { content: "$1" }, b: { content: "$2" } } }),
    hashSource({ message: "$a$$b$", placeholders: { b: { content: "$2" }, a: { content: "$1" } } }),
  );
});

test("first run with no target: everything is new", () => {
  const plan = planLocale(source, null, undefined, "de");
  assert.deepEqual(plan.translate.map((t) => [t.key, t.reason]), [["a", "new"], ["b", "new"], ["c", "new"]]);
});

test("unchanged keys are kept; changed, new and deleted keys are detected", () => {
  const target = { a: { message: "Apfel" }, b: { message: "Banane $n$" }, old: { message: "Alt" } };
  const st = stateFor(source, target);
  const changed: MessagesFile = { ...source, a: { message: "Green apple", description: "fruit" } };
  const plan = planLocale(changed, target, st, "de");
  assert.deepEqual(plan.translate, [
    { key: "a", reason: "changed" },
    { key: "c", reason: "new" },
  ]);
  assert.deepEqual(plan.keep, ["b"]);
  assert.deepEqual(plan.remove, ["old"]);
});

test("existing translations without state are adopted, never overwritten", () => {
  const target = { a: { message: "Apfel" }, b: { message: "Banane $n$" }, c: { message: "Kirsche" } };
  const plan = planLocale(source, target, undefined, "de");
  assert.deepEqual(plan.translate, []);
  assert.deepEqual(plan.adopt, ["a", "b", "c"]);
  const { state } = applyPlan(source, target, undefined, plan, {}, "mock");
  assert.equal(state.messages.a?.by, "adopted");
  assert.equal(state.messages.a?.sourceHash, hashSource(source.a!));
});

test("a broken existing translation is re-translated (reason: invalid)", () => {
  const target = { a: { message: "Apfel" }, b: { message: "Banane" }, c: { message: "" } };
  const plan = planLocale(source, target, stateFor(source, target), "de");
  assert.deepEqual(plan.translate, [{ key: "b", reason: "invalid" }, { key: "c", reason: "invalid" }]);
});

test("a hand translation that drops $$ is not marked invalid", () => {
  const src: MessagesFile = { p: { message: "Only $$5" } };
  const target = { p: { message: "Nur 5 €" } };
  const plan = planLocale(src, target, stateFor(src, target), "de");
  assert.deepEqual(plan.translate, []);
});

test("hand edits are kept and recorded as manual", () => {
  const target = { a: { message: "Apfel" }, b: { message: "Banane $n$" }, c: { message: "Kirsche" } };
  const st = stateFor(source, target);
  const edited = { ...target, a: { message: "Ein Apfel" } };
  const plan = planLocale(source, edited, st, "de");
  assert.deepEqual(plan.translate, []);
  assert.deepEqual(plan.manual, ["a"]);
  const { state } = applyPlan(source, edited, st, plan, {}, "mock");
  assert.equal(state.messages.a?.by, "manual");
  assert.equal(state.messages.a?.targetHash, hashTarget("Ein Apfel"));
});

test("--force re-translates every key", () => {
  const target = { a: { message: "Apfel" }, b: { message: "Banane $n$" }, c: { message: "Kirsche" } };
  const plan = planLocale(source, target, stateFor(source, target), "de", { force: true });
  assert.equal(plan.translate.length, 3);
  assert.ok(plan.translate.every((t) => t.reason === "forced"));
});

test("applyPlan: failed changed key keeps old text and old hash, so the next run retries", () => {
  const target = { a: { message: "Apfel" }, b: { message: "Banane $n$" }, c: { message: "Kirsche" } };
  const st = stateFor(source, target);
  const changed: MessagesFile = { ...source, a: { message: "Green apple" }, c: { message: "Sour cherry" } };
  const plan = planLocale(changed, target, st, "de");
  // Only c succeeded; a failed.
  const { file, state } = applyPlan(changed, target, st, plan, { c: "Sauerkirsche" }, "mock");
  assert.equal(file.a?.message, "Apfel");
  assert.equal(file.c?.message, "Sauerkirsche");
  assert.equal(state.messages.c?.sourceHash, hashSource(changed.c!));
  assert.equal(state.messages.a?.sourceHash, hashSource(source.a!));
  const again = planLocale(changed, file, state, "de");
  assert.deepEqual(again.translate, [{ key: "a", reason: "changed" }]);
});

test("applyPlan: output follows source key order and copies description and placeholders", () => {
  const plan = planLocale(source, null, undefined, "de");
  const { file } = applyPlan(source, null, undefined, plan, { c: "Kirsche", a: "Apfel", b: "Banane $n$" }, "mock");
  assert.deepEqual(Object.keys(file), ["a", "b", "c"]);
  assert.equal(file.a?.description, "fruit");
  assert.deepEqual(file.b?.placeholders, { n: { content: "$1" } });
});
