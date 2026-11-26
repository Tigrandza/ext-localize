// Pure helpers for translate mode: CLI arguments, reading `translate --json`,
// which files to commit, and the PR / summary text.
import { posix } from "node:path";
import { InputError, escapeMarkdown } from "./gha.mjs";

export const PROVIDERS = ["anthropic", "openai", "deepl", "ollama"];
const FORMALITIES = ["default", "more", "less", "prefer_more", "prefer_less"];
const LOCALE_RE = /^(all|[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*)$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const STORES = ["chrome", "firefox", "edge"];
/** GitHub rejects PR bodies over 65536 characters. */
export const BODY_LIMIT = 60000;
const FAILED_KEYS_SHOWN = 50;

/** Comma list of stores for --store. Returns "" when empty. */
export function parseStores(value) {
  const s = (value ?? "").replace(/\s+/g, "");
  if (!s) return "";
  const bad = s.split(",").filter((x) => !STORES.includes(x));
  if (bad.length) throw new InputError(`store: "${bad.join(", ")}" is not one of ${STORES.join(", ")}`);
  return s;
}

/**
 * Build `translate` arguments from inputs. Values are validated and passed as
 * --flag=value (so a value can never be read as another flag), never through a shell.
 * Provider, model, formality and locales may also come from .localizer/config.json,
 * so none of them is required here; the CLI reports what is missing (exit 2).
 */
export function buildTranslateArgs({ dir, provider, to, model, formality, store, dryRun, listing }) {
  const args = ["translate", `--dir=${dir}`, "--json"];
  if (listing) args.push("--listing");
  const p = (provider ?? "").trim();
  if (p) {
    if (!PROVIDERS.includes(p)) throw new InputError(`provider "${p}" is not one of ${PROVIDERS.join(", ")}`);
    args.push(`--provider=${p}`);
  }
  const t = (to ?? "").replace(/\s+/g, "");
  if (t) {
    const bad = t.split(",").filter((code) => !LOCALE_RE.test(code));
    if (bad.length) throw new InputError(`to: "${bad.join(", ")}" is not a locale code. Use a list like "de,fr,pt-BR" or "all".`);
    args.push(`--to=${t}`);
  }
  const m = (model ?? "").trim();
  if (m) {
    if (!MODEL_RE.test(m)) throw new InputError(`model "${m}" has characters that are not allowed`);
    args.push(`--model=${m}`);
  }
  const f = (formality ?? "").trim();
  if (f) {
    if (!FORMALITIES.includes(f)) throw new InputError(`formality "${f}" is not one of ${FORMALITIES.join(", ")}`);
    args.push(`--formality=${f}`);
  }
  const st = parseStores(store);
  if (listing && st) args.push(`--store=${st}`);
  if (dryRun) args.push("--dry-run");
  return args;
}

/**
 * Parse `translate --json` stdout. Returns null when it is not the expected JSON.
 * Error results look like {command, exitCode, ok: false, error}.
 */
export function parseTranslateJson(stdout) {
  try {
    const data = JSON.parse(stdout);
    return data && typeof data === "object" && data.command === "translate" ? data : null;
  } catch {
    return null;
  }
}

/** "_locales/<locale>/messages.json" -> /^_locales\/[^/]+\/messages\.json$/ */
export function patternToRegExp(pattern) {
  const parts = String(pattern).split(/<[^>]+>/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]+")}$`);
}

/**
 * Files to commit, relative to the extension folder: what the CLI says it
 * wrote (`filesWritten`), but only paths that also match its own `mayWrite`
 * patterns and stay inside the folder. Anything else stops the commit.
 */
export function commitPaths(runs) {
  const out = new Set();
  for (const r of runs) {
    const json = r.json;
    if (!json || !Array.isArray(json.filesWritten)) continue;
    const allowed = (json.mayWrite ?? []).map(patternToRegExp);
    for (const f of json.filesWritten) {
      const norm = posix.normalize(String(f));
      const inside = norm === f && !norm.startsWith("/") && !norm.split("/").includes("..") && !norm.split("/").includes(".git");
      if (!inside || !allowed.some((re) => re.test(norm))) {
        throw new Error(`the CLI reported writing "${f}", which is not in its own list of files it may write. Nothing was committed.`);
      }
      out.add(norm);
    }
  }
  return [...out].sort();
}

/** Put text in a fenced block that its own content cannot close. */
export function codeBlock(text) {
  const clean = String(text).replace(/\r/g, "").trimEnd();
  let fence = "```";
  while (clean.includes(fence)) fence += "`";
  return `${fence}text\n${clean}\n${fence}`;
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n… (cut; see the workflow log)` : text;
}

const TITLES = { messages: "Messages (`_locales`)", listing: "Store listing" };

/** Markdown section for one translate run: {target, exitCode, json, stderr}. */
export function renderRun({ target, exitCode, json, stderr }) {
  const out = [`### ${TITLES[target] ?? target}`, ""];
  if (!json) {
    out.push(`The CLI failed (exit code ${exitCode}) and gave no result. See the step log.`);
    if (stderr?.trim()) out.push("", codeBlock(clip(stderr, 5000)));
    return out.join("\n");
  }
  if (json.error) {
    out.push(`**Failed** (exit code ${json.exitCode}): ${escapeMarkdown(json.error)}`);
    return out.join("\n");
  }
  if (json.noTargets) {
    out.push("Nothing to do: there are no target locales. Set the `to` input (for example `de,fr`), add `to` to `.localizer/config.json`, or create the locale folders.");
    return out.join("\n");
  }
  if (json.stopped) out.push(`> **Stopped early:** ${escapeMarkdown(json.stopped)}. Finished locales are kept.`, "");
  if (json.locales?.length) {
    out.push("| Locale | New | Changed | Invalid | Removed | Kept | Translated | Failed | Note |");
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const l of json.locales) {
      const note = l.skipped ? `skipped: ${l.skipped}` : l.manual ? `${l.manual} edited by hand (kept)` : "";
      out.push(
        `| ${escapeMarkdown(l.locale)} | ${l.new} | ${l.changed} | ${l.invalid} | ${l.removed} | ${l.kept} | ${json.dryRun ? "–" : l.translated} | ${l.failed} | ${escapeMarkdown(note)} |`,
      );
    }
    out.push("");
  }
  const t = json.totals ?? {};
  out.push(
    json.dryRun
      ? `Dry run: ${t.strings ?? 0} string(s) to translate, about ${t.requests ?? 0} request(s), ${t.characters ?? 0} characters. Nothing was written.`
      : `${t.strings ?? 0} string(s) sent in ${t.requests ?? 0} request(s). ${t.failed ?? 0} failed.`,
  );
  const failed = (json.locales ?? []).flatMap((l) => (l.failedKeys ?? []).map((f) => ({ locale: l.locale, ...f })));
  if (failed.length) {
    out.push("", "**Not translated** (they stay in the default language; the next run tries again):", "");
    for (const f of failed.slice(0, FAILED_KEYS_SHOWN)) out.push(`- ${escapeMarkdown(f.locale)} > ${escapeMarkdown(f.key)}: ${escapeMarkdown(f.error)}`);
    if (failed.length > FAILED_KEYS_SHOWN) out.push(`- … and ${failed.length - FAILED_KEYS_SHOWN} more`);
  }
  if (json.check) {
    out.push("", `After translating, \`ext-localize check\` found ${json.check.errors} error(s), ${json.check.warnings} warning(s) and ${json.check.stale} stale string(s).`);
  }
  return out.join("\n");
}

/**
 * PR body and job summary for all runs of one job.
 * @param {{runs: object[], provider: string, dirLabel: string, runUrl?: string}} o
 */
export function renderTranslateBody({ runs, provider, dirLabel, runUrl }) {
  const out = [];
  out.push(`Translations from **ext-localize** (provider: ${escapeMarkdown(provider || "from config")}) for ${escapeMarkdown(dirLabel)}.`, "");
  for (const r of runs) out.push(renderRun(r), "");
  out.push(
    "Review the text before merging. Machine translations can be wrong in tone or meaning.",
    "",
    "This branch is rebuilt by the Action on every run. Commits you push to it are overwritten. To fix a translation, edit it on the default branch after merging; the tool keeps hand edits.",
  );
  if (runUrl) out.push("", `Created by [this workflow run](${runUrl}).`);
  let body = out.join("\n");
  if (body.length > BODY_LIMIT) body = body.slice(0, BODY_LIMIT) + "\n\n… (cut; see the workflow log)";
  return body;
}

/** Sum of strings that failed in all runs. */
export function failedCount(runs) {
  return runs.reduce((n, r) => n + (r.json?.totals?.failed ?? 0), 0);
}
