/**
 * Chrome message format tokens and how we protect them during translation.
 *
 * Chrome rules (https://developer.chrome.com/docs/extensions/mv3/i18n-messages):
 *   $$        -> a literal "$"
 *   $name$    -> a named placeholder, defined in the "placeholders" block.
 *                Names are case-insensitive and use A-Z a-z 0-9 _ @
 *   $1 .. $9  -> positional substitutions passed to chrome.i18n.getMessage()
 *
 * We scan left to right and try "$$" first, so "$$1" is a literal "$" then "1".
 */

export type FormatToken =
  | { kind: "dollar"; raw: string }
  | { kind: "named"; raw: string; name: string }
  | { kind: "positional"; raw: string; index: number }
  | { kind: "lone"; raw: string };

export type Segment = { kind: "text"; raw: string } | FormatToken;

const TOKEN_RE = /\$\$|\$([A-Za-z0-9_@]+)\$|\$([1-9])|\$/g;

/** Split a message into plain text and format tokens. */
export function tokenize(message: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(message); m; m = TOKEN_RE.exec(message)) {
    if (m.index > last) out.push({ kind: "text", raw: message.slice(last, m.index) });
    const raw = m[0];
    if (raw === "$$") out.push({ kind: "dollar", raw });
    else if (m[1] !== undefined) out.push({ kind: "named", raw, name: m[1].toLowerCase() });
    else if (m[2] !== undefined) out.push({ kind: "positional", raw, index: Number(m[2]) });
    else out.push({ kind: "lone", raw });
    last = m.index + raw.length;
  }
  if (last < message.length) out.push({ kind: "text", raw: message.slice(last) });
  return out;
}

export interface FormatSummary {
  /** Lower-cased placeholder names, sorted, unique. */
  named: string[];
  /** Positional indexes, sorted, unique. */
  positional: number[];
  /** Number of "$$" (literal dollar) tokens. */
  dollars: number;
  /** Number of "$" that are not part of any valid token. */
  lone: number;
}

export function summarizeFormat(message: string): FormatSummary {
  const named = new Set<string>();
  const positional = new Set<number>();
  let dollars = 0;
  let lone = 0;
  for (const s of tokenize(message)) {
    if (s.kind === "named") named.add(s.name);
    else if (s.kind === "positional") positional.add(s.index);
    else if (s.kind === "dollar") dollars++;
    else if (s.kind === "lone") lone++;
  }
  return {
    named: [...named].sort(),
    positional: [...positional].sort((a, b) => a - b),
    dollars,
    lone,
  };
}

export interface FormatProblem {
  /** "error": placeholder set differs. "warning": only "$$" count or stray "$" differs. */
  severity: "error" | "warning";
  message: string;
}

/**
 * Compare the format tokens of a source and a translated message.
 * Named and positional sets must match (error). A different "$$" count or a new
 * stray "$" is a warning: a human may write "4,99 EUR" on purpose, but from a
 * translator it usually means a broken token (restoreAndVerify treats all as errors).
 */
export function compareFormat(source: string, target: string): FormatProblem[] {
  const a = summarizeFormat(source);
  const b = summarizeFormat(target);
  const problems: FormatProblem[] = [];
  const error = (message: string) => problems.push({ severity: "error", message });
  const warning = (message: string) => problems.push({ severity: "warning", message });
  const missingNamed = a.named.filter((n) => !b.named.includes(n));
  const extraNamed = b.named.filter((n) => !a.named.includes(n));
  if (missingNamed.length) error(`missing placeholder(s) ${missingNamed.map((n) => `$${n}$`).join(", ")}`);
  if (extraNamed.length) error(`unknown placeholder(s) ${extraNamed.map((n) => `$${n}$`).join(", ")}`);
  const missingPos = a.positional.filter((n) => !b.positional.includes(n));
  const extraPos = b.positional.filter((n) => !a.positional.includes(n));
  if (missingPos.length) error(`missing substitution(s) ${missingPos.map((n) => `$${n}`).join(", ")}`);
  if (extraPos.length) error(`extra substitution(s) ${extraPos.map((n) => `$${n}`).join(", ")}`);
  if (a.dollars !== b.dollars) warning(`"$$" count differs (source ${a.dollars}, translation ${b.dollars})`);
  if (b.lone > a.lone) warning(`stray "$" in translation (use "$$" for a literal dollar sign)`);
  return problems;
}

/** True when the placeholder sets match (warnings allowed). */
export function placeholdersMatch(source: string, target: string): boolean {
  return compareFormat(source, target).every((p) => p.severity !== "error");
}

// ---------------------------------------------------------------------------
// Protection: swap tokens for opaque XML-like markers before translation.
// ---------------------------------------------------------------------------

export interface Protected {
  /** Text with markers: <x id="0"/> for format tokens, <x id="1">Term</x> for kept terms. */
  text: string;
  /** Original string for each marker id. */
  originals: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every Chrome format token (and every glossary "keep" term) with a
 * marker. Translators are told to copy markers unchanged.
 */
export function protect(
  message: string,
  keepTerms: readonly string[] = [],
  opts: { formatTokens?: boolean } = {},
): Protected {
  const originals: string[] = [];
  const terms = [...new Set(keepTerms.filter((t) => t.trim().length > 0))].sort((a, b) => b.length - a.length);
  const termRe = terms.length
    ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`, "gu")
    : null;

  let text = "";
  // Store listing text is not a Chrome message: "$4.99" is just text there.
  const segments: Segment[] = opts.formatTokens === false ? [{ kind: "text", raw: message }] : tokenize(message);
  for (const seg of segments) {
    if (seg.kind !== "text") {
      originals.push(seg.raw);
      text += `<x id="${originals.length - 1}"/>`;
      continue;
    }
    if (!termRe) {
      text += seg.raw;
      continue;
    }
    text += seg.raw.replace(termRe, (term) => {
      originals.push(term);
      return `<x id="${originals.length - 1}">${term}</x>`;
    });
  }
  return { text, originals };
}

const MARKER_RE = /<x\s+id\s*=\s*["']?(\d+)["']?\s*\/>|<x\s+id\s*=\s*["']?(\d+)["']?\s*>[\s\S]*?<\/x\s*>/g;

export type RestoreResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Put the original tokens back. Fails when a marker is missing, repeated,
 * unknown, or left half-broken.
 */
export function restore(translated: string, originals: readonly string[]): RestoreResult {
  const seen = new Map<number, number>();
  const unknownIds: number[] = [];
  const text = translated.replace(MARKER_RE, (_m, a: string | undefined, b: string | undefined) => {
    const id = Number(a ?? b);
    seen.set(id, (seen.get(id) ?? 0) + 1);
    if (id >= originals.length) {
      unknownIds.push(id);
      return "";
    }
    return originals[id] as string;
  });
  if (unknownIds.length) return { ok: false, error: `unknown marker id ${unknownIds.join(", ")}` };
  for (let i = 0; i < originals.length; i++) {
    const n = seen.get(i) ?? 0;
    if (n === 0) return { ok: false, error: `marker ${i} (${originals[i]}) is missing` };
    if (n > 1) return { ok: false, error: `marker ${i} (${originals[i]}) appears ${n} times` };
  }
  if (/<\/?x[\s>/]/.test(text)) return { ok: false, error: "broken marker left in text" };
  return { ok: true, text };
}

/**
 * Restore markers, then re-check the Chrome format tokens against the source.
 * This is the gate every translated string passes before it is written.
 */
export function restoreAndVerify(
  source: string,
  translated: string,
  originals: readonly string[],
  opts: { checkFormat?: boolean } = {},
): RestoreResult {
  const r = restore(translated, originals);
  if (!r.ok) return r;
  if (r.text.trim() === "" && source.trim() !== "") return { ok: false, error: "empty translation" };
  if (opts.checkFormat === false) return r;
  const problems = compareFormat(source, r.text);
  if (problems.length) return { ok: false, error: problems.map((p) => p.message).join("; ") };
  return r;
}
