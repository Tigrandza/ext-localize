# Changelog

## 0.3.2 (2026-11-27)

### Changed

- **A translation over its length limit is sent back to be shortened.** With an LLM provider (Anthropic, OpenAI, Ollama), a store listing field or a manifest `name` / `short_name` / `description` message that comes back longer than its limit is sent back to the model with the long text, its length and the limit, and a request to shorten it. Up to 3 tries; each try starts from the shortest answer so far. A shorter answer must keep every placeholder and glossary marker, or it is ignored. If it still does not fit, the result is the same as before: a listing field is not written and is listed as failed (the error now says "still too long after 3 shorten requests"); a manifest message is written and `check` warns. The request also says how many characters to cut at least and aims 10% under the limit, since models miscount. The log line shows `N shortened`; a manifest message that is still too long gets its own log line, and every "still too long" message lists the length of each shorten answer (or "broken" / "no answer"). When one string is asked and the model answers it under another key (seen with qwen3:8b), the answer is used. DeepL cannot shorten, so nothing changes there. Why: in the live Ollama run (qwen3:8b, 2026-11-27), even with the limit in the prompt, German and Spanish names and summaries of two extensions came back 93-175 characters for limits of 75 / 132.
- A listing field that is too long is no longer re-sent once with the same prompt before failing (when the provider can shorten); the shorten request replaces that retry.

## 0.3.1 (2026-11-27)

### Changed

- `translate` tells the model the store length limit of the messages the manifest uses as `name`, `short_name` and `description` (75 / 12 / 132 characters). In the first live Ollama run (qwen3:8b, 10 extensions, 3 languages), 7 of 60 names and summaries came back too long, because the model never saw the limit. A longer answer is still written; `check` warns as before. The source hash does not change, so nothing is re-translated.

### Fixed

- `check --zip` and `push chrome --zip` no longer warn "there is no listing/<locale>.json" for every locale when the project has no listing folder at all. Same rule as `check`: no listing folder, no listing issues. (Found while building the Plasmo example.)
- README: a code block in the WXT/Plasmo section was not closed, so the rest of the section showed as code on npm and GitHub.

### Added

- `examples/wxt` and `examples/plasmo`: small extensions with the manifest stub, `locales.dir` config and a translated locale. Both were built (WXT 0.21.5, Plasmo 0.90.5) and loaded in Chromium. A test keeps their configs and stubs in sync.

## 0.3.0 (2026-11-26)

The remaining items from the first field report (PageCarry, 32 locales).

### Added

- `--locales-dir <dir>` on every command, and config `locales.dir`: read and write `_locales` in another folder (for WXT: `public/_locales`) while `manifest.json` is read from `--dir` (the build output). Report paths show the real file, relative to `--dir`. A folder that does not exist is an error (exit 2).
- `--manifest <file>` on every command, and config `manifest`: read the manifest from any file. With `--locales-dir` and `--config`, a WXT or Plasmo project works before the first build.
- Config `check.ignoreKeys`: key patterns (`*` wildcard, case-insensitive) whose `check` issues are dropped. For brand names that trip the RTL warning, or key families another validator handles.
- Config `check.missingKeys`: `"warning"` makes a key missing in a non-default locale a warning instead of an error (Chrome falls back to the default locale). Default stays `"error"`.

## 0.2.1 (2026-11-18)

Fixes from the first real use on a live Chrome Web Store item (32 locales).

### Fixed

- **CRITICAL: `push chrome --copy` could put garbled text on the clipboard.** `pbcopy` decodes its input with the shell's locale. With no `LANG` / `LC_ALL` / `LC_CTYPE` set (agent shells, GUI-launched shells, CI, `env -i`), it read the UTF-8 script as MacRoman, so every non-ASCII character was garbled. The tool still printed "Copied", and the script's own check passed, because it compared the page with the already-garbled text. Three layers of protection now:
  - The paste script (and the diagnose script) are pure ASCII: every non-ASCII character is written as a `\uXXXX` escape (surrogate pairs for emoji). No clipboard or encoding step can change them.
  - `--copy` runs `pbcopy` and `pbpaste` with `LC_ALL=en_US.UTF-8`, reads the clipboard back and compares it with the file. On a mismatch it exits 1 and never prints "Copied".
  - Each description in the script carries its length in characters and a short SHA-256 hash, computed by the CLI from the listing files. The script fills nothing if any embedded text does not match, and its verify pass checks the page text against them. The report shows `length`, `wantLength` and `sha` per language.
- `check` no longer reports CLDR plural key families (`*_zero/_one/_two/_few/_many/_other`) as missing or extra keys. Each locale is checked against its own plural categories from `Intl.PluralRules`. `translate` keeps a locale's extra plural forms instead of deleting them and does not add forms the language does not use. See README "Plural keys".
- An absolute `listing.dir` was silently ignored. It is now used as is. A configured listing folder that does not exist is an error (exit 2).
- Listing messages showed `listing/<file>` even with another `listing.dir`. They now show the real path, matching the `file` field in `--json`.
- The warning for locale folders such as `nb` no longer says Chrome ignores or rejects them. The store does not offer them; the Chrome runtime may still use them.
- The RTL "may be untranslated" warning is quieter: it skips glossary `keep` terms, messages with fewer than 4 letters (`A4`, `KB`, `v1.x`) and short messages identical to the source (brand names).

### Added

- `--config <file>` on every command: `state.json`, `glossary.json` and `out/` are kept next to that file, so a build tool that wipes the extension folder (WXT, Plasmo) does not delete them. Relative paths inside the config are resolved from the folder that holds its folder.
- `--listing-dir <dir>` on every command.
- `ext-localize listing import <folder | "path/{locale}.txt">`: turns existing per-locale description files into listing files.
- `check --listing-only`.
- `check --zip <file>` and `push chrome --zip <file>`: compare the listing files with the `_locales` folders inside the package you upload.
- `check` text output ends with `OK` or `FAILED (...)`.
- `push chrome` prints the script size.

### Changed

- Listing problems in `check` now start with `listing: <path>` (for example `listing: ../store/listing/de.json: invalid JSON`).
- `fill-core.js` is 0.2.1: integrity check, code-point lengths in the report.
- `push chrome --copy` on a system other than macOS now exits 1 (it cannot copy); before, it printed a note and exited 0.

## 0.2.0 (2026-11-17)

- Store listing pack (`translate --listing`, listing checks), `push firefox`, `push chrome` (paste script and experimental `--auto`), `push edge`, `.localizer/config.json`.
- `check --stale`, `file` and `line` on issues, `translate --json`, exit code 3 for "no target locales".

## 0.1.0 (2026-11-16)

- `translate` (Anthropic, OpenAI, DeepL, Ollama) and `check` for `_locales`, diff state in `.localizer/state.json`, glossary.
