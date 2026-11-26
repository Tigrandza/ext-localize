import assert from "node:assert/strict";
import { test } from "node:test";
import { compareFormat, protect, restore, restoreAndVerify, summarizeFormat, tokenize } from "../src/placeholders.ts";

test("tokenize: $$ is tried first, so $$1 is a literal dollar then '1'", () => {
  const segs = tokenize("Pay $$1 now");
  assert.deepEqual(segs.map((s) => [s.kind, s.raw]), [["text", "Pay "], ["dollar", "$$"], ["text", "1 now"]]);
  assert.deepEqual(summarizeFormat("$$5").positional, []);
  assert.equal(summarizeFormat("$$5").dollars, 1);
});

test("tokenize: named placeholders are case-insensitive, positional $1-$9", () => {
  const s = summarizeFormat("Hi $User_Name$, you have $1 of $2 ($COUNT$ / $count$)");
  assert.deepEqual(s.named, ["count", "user_name"]);
  assert.deepEqual(s.positional, [1, 2]);
  assert.equal(s.lone, 0);
});

test("tokenize: a lone $ is reported, $0 is not a substitution", () => {
  const s = summarizeFormat("Costs $ 5 or $0");
  assert.equal(s.lone, 2);
  assert.deepEqual(s.positional, []);
});

test("protect + restore round trip keeps every token", () => {
  const src = "Saved $count$ tabs to \"$session_name$\" for $$4.99 at $1";
  const p = protect(src);
  assert.equal(p.text, 'Saved <x id="0"/> tabs to "<x id="1"/>" for <x id="2"/>4.99 at <x id="3"/>');
  assert.deepEqual(p.originals, ["$count$", "$session_name$", "$$", "$1"]);
  const translated = 'Für <x id="2"/>4,99 um <x id="3"/>: <x id="0"/> Tabs in "<x id="1"/>" gespeichert';
  const r = restore(translated, p.originals);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, 'Für $$4,99 um $1: $count$ Tabs in "$session_name$" gespeichert');
});

test("restore tolerates spacing and quote changes inside markers", () => {
  const r = restore("A <x id='0' /> B <x  id=\"1\"/>", ["$a$", "$1"]);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, "A $a$ B $1");
});

test("restore fails on missing, repeated, unknown and broken markers", () => {
  const originals = ["$a$", "$1"];
  assert.match((restore('<x id="0"/> only', originals) as { error: string }).error, /marker 1 .* missing/);
  assert.match((restore('<x id="0"/><x id="0"/><x id="1"/>', originals) as { error: string }).error, /appears 2 times/);
  assert.match((restore('<x id="0"/><x id="1"/><x id="7"/>', originals) as { error: string }).error, /unknown marker/);
  assert.match((restore('<x id="0"/><x id="1"/> <x id="2"', originals) as { error: string }).error, /broken marker/);
});

test("keep terms are wrapped and restored to the original spelling", () => {
  const p = protect("Open TabNest in Chrome. TabNests is not a term.", ["TabNest", "Chrome"]);
  assert.equal(p.text, 'Open <x id="0">TabNest</x> in <x id="1">Chrome</x>. TabNests is not a term.');
  // The model changed the inner text; we still restore the original term.
  const r = restore('Öffne <x id="0">TabNestt</x> in <x id="1">Chrome</x>.', p.originals);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, "Öffne TabNest in Chrome.");
});

test("keep terms use Unicode word boundaries", () => {
  const p = protect("ÜberPro Pro proPro", ["Pro"]);
  assert.equal(p.text, 'ÜberPro <x id="0">Pro</x> proPro');
});

test("restoreAndVerify catches a stray $ the model added", () => {
  const p = protect("Price: $$5");
  const r = restoreAndVerify("Price: $$5", 'Preis: <x id="0"/>5 $', p.originals);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /stray "\$"/);
});

test("restoreAndVerify rejects empty translations", () => {
  const r = restoreAndVerify("Hello", "  ", []);
  assert.equal(r.ok, false);
});

test("compareFormat lists every difference", () => {
  assert.deepEqual(compareFormat("$a$ $1 $$", "$A$ $1 $$"), []);
  const problems = compareFormat("$a$ $1 $$", "$b$ $2");
  assert.equal(problems.length, 5);
  assert.equal(problems.filter((p) => p.severity === "warning").length, 1);
});
