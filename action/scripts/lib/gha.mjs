// Small helpers for the GitHub Actions runner protocol.
// No dependencies: we do not use @actions/core, so nothing needs bundling.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Escape the message part of a workflow command (::error ...::message). */
export function escapeData(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escape a property value of a workflow command (file=..., title=...). */
export function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/**
 * Build one annotation line, for example
 * ::error file=_locales/de/messages.json,line=4,title=ext-localize::text
 */
export function annotation(level, { file, line, title }, message) {
  const props = [];
  if (file) props.push(`file=${escapeProperty(file)}`);
  if (line) props.push(`line=${Number(line)}`);
  if (title) props.push(`title=${escapeProperty(title)}`);
  return `::${level}${props.length ? " " + props.join(",") : ""}::${escapeData(message)}`;
}

/**
 * Write step outputs to $GITHUB_OUTPUT. Uses the heredoc form with a random
 * delimiter, so values with line breaks are safe.
 */
export function setOutputs(outputs, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  let text = "";
  for (const [name, value] of Object.entries(outputs)) {
    const delimiter = `ghadelimiter_${randomUUID()}`;
    text += `${name}<<${delimiter}\n${value ?? ""}\n${delimiter}\n`;
  }
  appendFileSync(file, text, "utf8");
}

/** Append markdown to the job summary ($GITHUB_STEP_SUMMARY). */
export function appendSummary(markdown, env = process.env) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, markdown.endsWith("\n") ? markdown : markdown + "\n", "utf8");
}

/** Read a boolean input ("true"/"false", case-insensitive). */
export function boolInput(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  throw new InputError(`expected "true" or "false", got "${value}"`);
}

/** A problem with the workflow inputs. The message is shown as is. */
export class InputError extends Error {}

/**
 * Escape text for use inside markdown (tables, lists). Text from the
 * extension repo (key names, issue text) must not turn into links, HTML or
 * broken table cells in the summary.
 */
export function escapeMarkdown(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/([`*_[\]#~])/g, "\\$1")
    .replace(/@/g, "&#64;")
    .replace(/\r?\n/g, " ");
}

/** Make text safe for a one-line log: a line break could start a workflow command. */
export function oneLine(value) {
  return String(value).replace(/\r?\n|\r/g, " ");
}

/**
 * Print text that may contain anything (CLI output with key names from the repo)
 * with workflow commands turned off, so no line in it is read as "::command::".
 */
export function logUntrusted(text, log = console.log) {
  const token = `ext-localize-${randomUUID()}`;
  log(`::stop-commands::${token}`);
  log(text);
  log(`::${token}::`);
}
