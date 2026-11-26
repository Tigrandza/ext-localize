// Turn a `check --json` report into: a pass/fail decision, a markdown job
// summary, and annotation lines. Stale strings come from the CLI itself
// (`check --stale=...`): issues with kind "stale", plus `stale` and `staleCheck`.
import { posix } from "node:path";
import { annotation, escapeMarkdown } from "./gha.mjs";

/** Action input `stale` -> CLI `check --stale=` value. */
export const STALE_MODES = { fail: "error", warn: "warning", ignore: "off" };

/** GitHub shows at most 10 error and 10 warning annotations per step. */
export const ANNOTATION_LIMIT = 10;
const SUMMARY_ROW_LIMIT = 200;

export function staleFlag(staleMode) {
  const v = STALE_MODES[staleMode];
  if (!v) throw new Error(`unknown stale mode ${staleMode}`);
  return `--stale=${v}`;
}

/**
 * The CLI already counts stale strings as errors (`--stale=error`) or
 * warnings (`--stale=warning`), so this is the same rule as its exit code.
 * @returns {{failed: boolean, reasons: string[]}}
 */
export function decide({ report, strict }) {
  const reasons = [];
  const stale = report.stale ?? 0;
  const staleLevel = report.staleCheck?.mode;
  // With --stale=error the CLI counts stale strings inside `errors`; name them apart.
  const staleErrors = staleLevel === "error" ? Math.min(stale, report.errors) : 0;
  const other = report.errors - staleErrors;
  if (other > 0) reasons.push(`${other} error(s)`);
  if (staleErrors > 0) reasons.push(`${staleErrors} stale string(s)`);
  if (strict && report.warnings > 0) reasons.push(`${report.warnings} warning(s) (strict is on)`);
  return { failed: reasons.length > 0, reasons };
}

/** Repo-relative path of an issue's file: the CLI gives it relative to --dir. */
export function issueFile(dirLabel, issue) {
  if (!issue.file) return undefined;
  return dirLabel === "." ? issue.file : posix.join(dirLabel.split("\\").join("/"), issue.file);
}

function where(issue) {
  if (!issue.locale) return issue.key ? `${issue.key}: ` : "";
  return `${issue.locale}${issue.key ? ` > ${issue.key}` : ""}: `;
}

/**
 * Annotation lines for the log. Capped per level, because GitHub drops the rest.
 * @returns {{lines: string[], dropped: number}}
 */
export function buildAnnotations({ report, strict, dirLabel }) {
  const counts = { error: 0, warning: 0 };
  const lines = [];
  let dropped = 0;
  for (const issue of report.issues) {
    const level = issue.level === "error" || strict ? "error" : "warning";
    if (counts[level] >= ANNOTATION_LIMIT) {
      dropped++;
      continue;
    }
    counts[level]++;
    lines.push(annotation(level, { file: issueFile(dirLabel, issue), line: issue.line, title: "ext-localize" }, `${where(issue)}${issue.message}`));
  }
  return { lines, dropped };
}

const icon = (ok) => (ok ? "✅" : "❌");

function staleCell(report) {
  const sc = report.staleCheck;
  if (!sc) return "unknown (old CLI?)";
  if (sc.status === "off" || sc.mode === "off") return "off";
  if (sc.status !== "ok") return "not checked";
  return `${report.stale ?? sc.stale}${sc.mode === "warning" && (report.stale ?? 0) > 0 ? " (warn only)" : ""}`;
}

/** Markdown for $GITHUB_STEP_SUMMARY. All text from the repo is escaped. */
export function renderCheckSummary({ report, strict, decision, dirLabel, droppedAnnotations = 0 }) {
  const out = [];
  const sc = report.staleCheck;
  const staleIssues = report.issues.filter((i) => i.kind === "stale");
  const otherIssues = report.issues.filter((i) => i.kind !== "stale");

  out.push(`## ${icon(!decision.failed)} ext-localize check`);
  out.push("");
  out.push(`Folder: ${escapeMarkdown(dirLabel)} · default locale: **${escapeMarkdown(report.defaultLocale ?? "none")}** · ${report.locales.length} locale(s)`);
  out.push("");
  out.push("| Errors | Warnings | Stale strings |");
  out.push("| --- | --- | --- |");
  out.push(`| ${report.errors} | ${report.warnings}${strict ? " (strict)" : ""} | ${staleCell(report)} |`);
  out.push("");
  if (staleIssues.length && sc?.mode !== "off") out.push("Stale strings are included in the error or warning count.", "");
  if (decision.failed) out.push(`**Failed:** ${decision.reasons.join(", ")}.`, "");
  if (sc && sc.status !== "ok" && sc.status !== "off" && sc.note) out.push(`> ${escapeMarkdown(sc.note)}`, "");
  if (sc?.untracked > 0) {
    out.push(`${sc.untracked} translated string(s) have no entry in the state file, so their age is unknown. The next translate run records them.`, "");
  }

  if (otherIssues.length) {
    out.push("### Issues", "");
    out.push("| Level | File | Key | Problem |");
    out.push("| --- | --- | --- | --- |");
    for (const issue of otherIssues.slice(0, SUMMARY_ROW_LIMIT)) {
      const file = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : issue.locale ?? "";
      out.push(`| ${issue.level} | ${escapeMarkdown(file)} | ${escapeMarkdown(issue.key ?? "")} | ${escapeMarkdown(issue.message)} |`);
    }
    if (otherIssues.length > SUMMARY_ROW_LIMIT) out.push("", `… and ${otherIssues.length - SUMMARY_ROW_LIMIT} more. Run \`ext-localize check\` locally for the full list.`);
    out.push("");
  }

  if (staleIssues.length) {
    out.push("### Stale strings", "");
    out.push("The source text changed after these were translated. Run `ext-localize translate` (or this Action with `mode: translate`) to update them.", "");
    out.push("| Locale | Keys |");
    out.push("| --- | --- |");
    const grouped = new Map();
    for (const i of staleIssues) {
      const loc = i.locale ?? i.file ?? "?";
      if (!grouped.has(loc)) grouped.set(loc, []);
      grouped.get(loc).push(i.key ?? "");
    }
    for (const [locale, keys] of [...grouped].slice(0, SUMMARY_ROW_LIMIT)) {
      const shown = keys.slice(0, 30).map(escapeMarkdown).join(", ");
      out.push(`| ${escapeMarkdown(locale)} | ${shown}${keys.length > 30 ? `, … (${keys.length} in total)` : ""} |`);
    }
    out.push("");
  }
  if (droppedAnnotations > 0) {
    out.push(`GitHub shows only the first ${ANNOTATION_LIMIT} annotations of each level; ${droppedAnnotations} more are only in this summary.`, "");
  }
  return out.join("\n");
}
