# ext-localize

Translate, check and keep in sync the `_locales/*/messages.json` files of a Chrome (Manifest V3) extension, and the store listing text for the Chrome Web Store, Firefox Add-ons and Edge Add-ons.

- **Local-first.** Runs on your machine. Bring your own API key, or use a local model with Ollama.
- **Only changed strings.** It remembers what it translated. The next run sends only new or changed keys.
- **Safe placeholders.** `$NAME$`, `$1`..`$9` and `$$` always survive translation.
- **CI check.** `ext-localize check` exits with an error when a locale would break or is incomplete.
- **Store listings.** Translate the name, summary and long description once, then deliver them: one PATCH to Firefox, one paste for Chrome, copy-ready files for Edge.

Published on npm as [`ext-localize`](https://www.npmjs.com/package/ext-localize). Run it with `npx ext-localize`, or install it with `npm install -D ext-localize`. Needs Node 20 or newer.

## Quick start

1. Go to your extension folder (the one with `manifest.json`). It needs `"default_locale"` and `_locales/<default>/messages.json`.
2. See what would happen. This makes no API calls and writes nothing:
   ```bash
   npx ext-localize translate --to de,fr,ja --dry-run
   ```
3. Set a key and translate:
   ```bash
   export DEEPL_API_KEY=...        # or ANTHROPIC_API_KEY / OPENAI_API_KEY
   npx ext-localize translate --provider deepl --to de,fr,ja
   ```
4. Check every locale:
   ```bash
   npx ext-localize check
   ```
5. Commit `_locales/` and `.localizer/state.json`. Next time, just run `npx ext-localize translate --provider deepl`. With no `--to`, it uses the locale folders that already exist.
6. Optional, the store listing: write `listing/en.json` (see [Store listing](#store-listing)), then:
   ```bash
   npx ext-localize translate --listing --provider deepl
   npx ext-localize push chrome --copy        # paste into the dashboard, click Save draft
   npx ext-localize push firefox --addon my-addon        # dry run; add --send to send
   ```

To run it from a clone of the repository instead (for development):

```bash
cd cli
npm install
node src/cli.ts translate --dir ../path/to/extension --to de --dry-run
```

(Running `.ts` files directly needs Node 22.18+ or 23.6+. The published package is compiled JavaScript and runs on Node 20+. CI installs the packed package and runs it on Node 20, 22 and 24.)

## Commands

### `translate`

```
ext-localize translate --provider <name> [--to <locales>] [options]
```

| Option | Meaning |
| --- | --- |
| `--provider` | `anthropic`, `openai`, `deepl` or `ollama` |
| `--listing` | Translate the store listing (`listing/<locale>.json`) instead of `_locales`. See [Store listing](#store-listing). |
| `--store` | With `--listing`: stores whose length limits apply, for example `chrome,firefox`. Default: `stores` in the config file, else `chrome`. |
| `--json` | Print a machine-readable result on stdout. Progress lines go to stderr. See [translate --json](#translate---json). |
| `--to` | `all` (all 55 Chrome locales) or a list like `de,fr,pt-BR`. Codes are normalised: `pt-BR` becomes `pt_BR`. Default: the locale folders that already exist. The default locale is never written. |
| `--model` | Model id. Anthropic default: `claude-opus-5-5`. Required for `openai` and `ollama`. |
| `--effort` | Anthropic only: `low`, `medium` (default), `high`, `xhigh`, `max` |
| `--formality` | `default`, `more`, `less`, `prefer_more`, `prefer_less`. Formal or informal tone (German "Sie" or "du"). See [Formality](#formality). |
| `--glossary` | Glossary file. Default: `.localizer/glossary.json` if it exists. |
| `--dry-run` | Show what would be translated, the request count and a rough size. No API calls, no writes. |
| `--force` | Re-translate every key, even unchanged ones. |
| `--batch-size` | Max strings per request. |
| `--concurrency` | Locales translated at the same time (default 4). |
| `--dir` | Extension folder (default: current folder). |

Exit code: `0` when every string was translated, `1` when some failed (they are listed) or the run stopped, `2` for usage or setup errors, `3` when there are no target locales. See [Exit codes](#exit-codes).

**Files `translate` may write** (nothing else, except the generated `.localizer/out/` of the `push` commands):

| Command | Files |
| --- | --- |
| `translate` | `_locales/<locale>/messages.json` (never the default locale), `.localizer/state.json` |
| `translate --listing` | `<listing dir>/<locale>.json` (default `listing/`; never the source file), `.localizer/state.json` |

A file is only rewritten when its content changes. `--json` lists the files actually written in `filesWritten`, and this list as patterns in `mayWrite`. DeepL glossaries are created on your DeepL account, not as files.

#### `translate --json`

```json
{
  "command": "translate",
  "target": "messages",
  "dryRun": false,
  "provider": "deepl",
  "exitCode": 1,
  "ok": false,
  "noTargets": false,
  "stopped": null,
  "locales": [
    {
      "locale": "de",
      "new": 2, "changed": 1, "invalid": 0, "forced": 0, "removed": 1, "kept": 22,
      "adopted": 0, "manual": 0, "translated": 2, "failed": 1, "requests": 1,
      "skipped": null,
      "failedKeys": [{ "key": "actionTitle", "error": "marker 0 ($count$) is missing" }],
      "written": ["_locales/de/messages.json"]
    }
  ],
  "totals": { "strings": 3, "requests": 1, "characters": 120, "failed": 1 },
  "filesWritten": [".localizer/state.json", "_locales/de/messages.json"],
  "mayWrite": ["_locales/<locale>/messages.json", ".localizer/state.json"],
  "check": { "errors": 0, "warnings": 2, "stale": 0 }
}
```

| Field | Meaning |
| --- | --- |
| `target` | `messages`, or `listing` with `--listing` |
| `noTargets` | `true` when there was nothing to translate into (exit code 3) |
| `stopped` | `null`, or why the run stopped early (bad key, quota, 3 failures in a row) |
| `locales[].new` … `kept` | Same as the text table. `new` includes keys missing from a locale file. `adopted`/`manual`: kept keys that existed before the first run / were edited by hand. |
| `locales[].skipped` | `null`, or why the locale was not translated (for example the provider does not support it) |
| `locales[].failedKeys` | Every key that was not written, with the reason |
| `check` | Counts of a `check` run after translating (`null` for `--dry-run` or no targets) |

When the command fails with an error before it can produce a result (usage or setup error, exit 2; or, for example, a missing API key, exit 1), `--json` prints `{"command", "exitCode", "ok": false, "error"}` instead.

Example dry run:

```
locale  new  changed  invalid  forced  removed  kept  requests  note
de      2    1        0        0       1        22    1
fr      25   0        0        0       0        0     1

Dry run: 28 string(s) to translate in 2 locale(s), about 2 request(s) to deepl, about 1190 characters billed.
Nothing was written.
```

### `check`

```
ext-localize check [--dir <path>] [--json] [--strict] [--store chrome,firefox,edge] [--stale warning|error|off]
                   [--listing-only] [--zip <package.zip>]
```

- `--listing-only`: only the listing checks (plus project-level problems such as an unreadable manifest). Use it to gate the store listing in CI when `_locales` has its own validator.
- `--zip <file>`: also compare the listing files with the `_locales` folders inside the package you upload. The dashboard offers a language only when the uploaded package has that folder. Each mismatch is a warning.
- The text output ends with `OK` or `FAILED (...)`, matching the exit code.
- Config `check.ignoreKeys` (a list of key patterns; `*` matches anything, case-insensitive) drops every issue for matching keys, errors included. Use it for keys the checks cannot judge, such as brand names in an RTL locale (`"appShortName"`) or a key family your own validator handles (`"*_zero"`). Listing keys look like `listing.name`.
- Config `check.missingKeys: "warning"` turns "missing (present in source)" in a non-default locale into a warning. Chrome falls back to the default locale for a missing key, so this is safe at runtime; the user just sees the default language there. Default `"error"`. `--strict` still fails on it.

Exit code `1` on any error. `--strict` also fails on warnings. `--json` prints a machine-readable report:

```json
{
  "defaultLocale": "en",
  "locales": ["de", "en"],
  "issues": [
    {
      "level": "warning",
      "kind": "stale",
      "locale": "de",
      "key": "actionTitle",
      "message": "source changed after translation (by deepl); run \"ext-localize translate\" to update",
      "file": "_locales/de/messages.json",
      "line": 12
    }
  ],
  "errors": 0,
  "warnings": 1,
  "stale": 1,
  "staleCheck": { "mode": "warning", "status": "ok", "stale": 1, "untracked": 0, "note": "1 translated string(s) are older than their source text." }
}
```

- Every issue has `level`, `locale` (`null` for the manifest or the state file), `message` and `file` (relative to `--dir`, `/` separators). `key` is set when the issue is about one key; listing keys look like `listing.name`. `line` (1-based) is set when it can be found: the key's line, the `__MSG_key__` line in `manifest.json`, or the line of a JSON syntax error. A missing key has no line. (For `manifest.json` with block comments, a syntax-error line may be off.)
- `kind` is set only by the stale check: `"stale"` for one stale string, `"state"` when `.localizer/state.json` cannot be used.
- `errors` and `warnings` count all issues, stale ones included. `stale` counts issues with `kind: "stale"`.
- A project without a `listing/` folder gets no listing issues.

**Stale strings.** A translation is stale when its source text (or placeholders) changed after it was translated: the `sourceHash` in `.localizer/state.json` no longer matches the source. This is the same test `translate` uses for its `changed` column, so `translate` fixes exactly these. Listing fields are checked the same way (and fixed by `translate --listing`), except name and summary copied from `_locales`: those are re-copied on every `translate --listing` run, so only their `_locales` message can be stale.

| `--stale` | Effect |
| --- | --- |
| `warning` (default) | Stale strings are warnings. `check` still exits 0 unless `--strict`. The default keeps old CI setups passing. |
| `error` | Stale strings are errors (exit 1). An unreadable state file or an unknown state version is also an error. |
| `off` | Not checked. |

`staleCheck.status` says what happened: `ok`, `off`, `no-state` (no state file: nothing checked, no issue), `bad-state` / `unknown-version` (issue with kind `state`), `source-locale-changed` (warning; the next `translate` resets the state), `no-source`. `untracked` counts translated keys that have no state entry (written before the tool was used), whose age is unknown. A key that is stale **and** has broken placeholders is reported twice: as stale, and as a placeholder error (`translate` plans it as `invalid`).

`--store` picks whose listing limits apply (default: `stores` in the config file, else `chrome`). See [Listing checks](#listing-checks).

**Errors** (Chrome breaks, or the locale is incomplete):

- `messages.json` does not parse. Chrome drops that locale silently.
- A locale folder has no `messages.json`. Chrome refuses to load the extension.
- `_locales/` exists but the manifest has no `default_locale`, or the default locale folder is missing.
- A source key is missing, or a key is not in the source (extra key). Plural families are an exception; see [Plural keys](#plural-keys).
- The placeholder set of a message differs from the source: `$name$` (case-insensitive) or `$1`..`$9`.
- A `$name$` is used but not defined in that file's own `placeholders` block.
- Keys starting with `@@` (reserved by Chrome).
- Key names with characters other than `A-Z a-z 0-9 _ @`, or two keys that differ only in case.
- Empty messages, or entries without a `message` string.
- The manifest uses `__MSG_key__` but the key is missing from the default locale.

**Warnings:**

- RTL locales (`ar`, `he`, `fa`): a message with no right-to-left letters (maybe untranslated). To keep it quiet, it skips glossary `keep` terms, messages with fewer than 4 letters (`A4`, `KB`, `v1.x`) and short messages (up to 3 words) identical to the source (brand names).
- Localized manifest `name` over 75, `short_name` over 12, or `description` over 132 characters.
- The number of `$$` (literal dollar) differs from the source, or a new stray `$` appears. A human may do this on purpose (for example "4,99 €"), so it is only a warning. Machine translations with this problem are never written.
- Locale folder names that are not Chrome Web Store locales (for example `nb`): the store will not offer them, but the Chrome runtime may still use them. A byte order mark (BOM), unused placeholders in the source, a stray `$` in the source.
- A plural form the locale's language uses but the locale file lacks, or a plural form the language does not use.

#### Plural keys

Chrome has no plural support, so many extensions keep one key per CLDR plural category: `files_one`, `files_other`, plus `files_few` and `files_many` in Russian, and only `files_other` in Japanese. ext-localize recognises such a **family** automatically when the source has `<base>_other` and at least one more `<base>_zero|one|two|few|many` key. For each locale it uses the categories of that language from `Intl.PluralRules(locale).resolvedOptions().pluralCategories`:

| Situation | Result |
| --- | --- |
| Source form the language does not use is missing (`files_one` in `ja`) | fine, no issue |
| Extra form the language uses (`files_few` in `ru`) | fine; its placeholders are compared with the source `files_other` |
| Extra form the language does not use (`files_few` in `de`) | warning |
| A form the language uses is missing and the source has no such key (`files_many` in `ru`) | warning |
| A source form the language uses is missing (`files_one` in `de`) | error, as for any missing key |

The categories come from the `Intl` data of the Node.js version that runs the tool, so a different Node version can give slightly different warnings.

`translate` follows the same rules: it never deletes a locale's extra plural forms and does not add forms the language does not use. It does not create new forms (such as `_few`) that the source lacks; write those by hand.

Use it in CI:

```yaml
- run: npx ext-localize check
```

## Providers

API keys are read from environment variables only. They are never written to disk.

| Provider | Key | Notes |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` (or an `ant auth login` profile) | Official SDK. Default model `claude-opus-5-5`. Use `--model claude-sonnet-5-5` or `--model claude-haiku-5-5` for lower cost. JSON output is enforced with a schema. Server-side refusal fallback is on. The SDK retries rate limits. |
| `openai` | `OPENAI_API_KEY` | Chat Completions with a strict JSON schema. Pass `--model` (or `OPENAI_MODEL`); there is no default. Set `OPENAI_BASE_URL` to use any OpenAI-compatible server, for example LM Studio or vLLM on your machine. |
| `deepl` | `DEEPL_API_KEY` | Keys ending in `:fx` use the free API host. For listing text, each line is sent as its own text (in XML mode DeepL does not treat a line break as a sentence end, so list items could merge); blank lines and indentation are kept locally. UI messages are sent whole. Supported languages are read from DeepL, and unsupported locales are skipped with a note (for example `am` and `kn` today; `--dry-run` does not know this yet and counts them). DeepL has one `context` per request, so descriptions are sent there only as loose background, each quoted with its source text. Supports `--formality` and glossary `terms` (see below). |
| `ollama` | none | Local model, nothing leaves your machine. Pass `--model` (see `ollama list`). `OLLAMA_HOST` defaults to `http://localhost:11434`. Smaller batches. |

**What is sent:** the message text (with placeholders replaced by markers), its `description`, notes about what each placeholder means (with the `example`), the store length limit for the messages your manifest uses as `name`, `short_name` and `description` (75 / 12 / 132 characters; a longer answer is still written, and `check` warns), and the glossary terms for that locale. Nothing else from your extension is sent.

**Batching and retries:** many keys go in one request (40 for LLMs, 50 for DeepL, 15 for Ollama). Rate limits (HTTP 429) and server errors are retried with backoff, and `Retry-After` is respected. If an answer is cut off, the batch is split in two and sent again. Keys that come back missing or with broken placeholders are re-sent one by one; if they still fail, they are not written and are listed in the output. A request that fails on the network or HTTP level (after retries) is not re-sent key by key. The run stops at once on an auth error (401/403), a wrong model or URL (404) or DeepL quota (456), and after 3 failed requests in a row. Finished locales are kept.

**Adding a provider:** implement the `Provider` interface in `src/providers/types.ts` (`translateBatch` gets a list of `{key, text, description}` and returns `key -> text`), then register it in `src/providers/index.ts`.

## How placeholders are protected

Before sending, every Chrome format token is replaced by a marker:

```
Saved $count$ tabs to "$session_name$" for $$4.99
Saved <x id="0"/> tabs to "<x id="1"/>" for <x id="2"/>4.99
```

After translation, the markers are replaced back. Each marker must appear exactly once. Then the result is checked again against the source (same placeholders, same `$$` count, no new stray `$`). A string that fails is never written.

Tokens are read left to right and `$$` is tried first, so `$$1` is a literal `$` followed by `1`.

The `placeholders` blocks are copied from the source unchanged.

## Only changed strings: the diff state

`translate` stores a hash of every source message in `.localizer/state.json`, per locale. On the next run, for each locale and key:

| Situation | What happens |
| --- | --- |
| Key is not in the locale file | translated (`new`) |
| Locale message is broken (empty, or the placeholder set differs) | translated again (`invalid`) |
| Source text or placeholders changed since the last translation | translated again (`changed`) |
| Key is in the locale file but not in the state (first run on an existing project) | **kept**, and recorded as `adopted`. Existing translations are never overwritten on the first run. Use `--force` to re-translate. |
| Translation was edited by hand since we wrote it | kept, recorded as `manual` |
| Key was deleted from the source | removed from the locale file |
| Otherwise | kept |

Editing only a `description` does not trigger re-translation.

State is written after each locale finishes. If a run stops in the middle, the finished locales are saved and the next run continues with the rest.

### State file format

`.localizer/state.json` (version 1). Keys are sorted so the file diffs cleanly. Commit it.

```json
{
  "version": 1,
  "sourceLocale": "en",
  "locales": {
    "de": {
      "messages": {
        "extName": {
          "sourceHash": "3332…0843",
          "targetHash": "9c0f…1a06",
          "by": "deepl"
        }
      }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `version` | Format version. Tools must refuse versions they do not know. |
| `sourceLocale` | The `default_locale` the hashes were made from. If it changes, the state is reset. |
| `locales.<locale>.listing.<field>` | Optional (added in 0.2, still version 1). Same three fields per listing field (`name`, `summary`, `description`). The hashes are made the same way, with an empty placeholder list. `by` may also be `_locales` (copied from `_locales`, not translated). Tools that do not know `listing` can ignore it. |
| `locales.<locale>.messages.<key>.sourceHash` | SHA-256 (hex) of `JSON.stringify({message, placeholders})`, where `placeholders` is a list of `[name in lower case, content]` pairs sorted by name. The description is not included. |
| `…targetHash` | SHA-256 (hex) of the translated `message` string as written. If the file's text no longer matches, someone edited it by hand. |
| `…by` | Who wrote the text: `deepl`, `anthropic/<model>`, `openai/<model>`, `ollama/<model>`, `adopted` (existed before the first run) or `manual` (edited by hand). |

A key with no entry has never been translated by this tool.

## Glossary

`.localizer/glossary.json`:

```json
{
  "keep": ["TabNest", "Chrome", "Pro"],
  "terms": {
    "workspace": { "de": "Arbeitsbereich", "fr": "espace de travail" }
  }
}
```

- `keep`: words that must never be translated (brand and product names). They are protected like placeholders, so every provider keeps them. Matching is case-sensitive and whole-word.
- `terms`: a fixed translation per locale.
  - LLM providers get them as instructions in the prompt.
  - DeepL gets a real DeepL glossary, so the terms are enforced. ext-localize creates one glossary per target locale on your DeepL account, named `ext-localize en->de <hash>`. The hash comes from the terms, so the same terms reuse the same glossary, and a new one is made only when the terms change. Old glossaries are **not** deleted; remove them in your DeepL account if you change terms often (the limit is 1000 glossaries per account).
  - DeepL rejects empty terms, tabs or line breaks inside a term, and duplicate source terms. Those are dropped with a note. Thai cannot use glossaries; you get a note and the terms are not applied.

## Formality

`--formality` sets the tone and form of address, for example German "Sie" (formal) or "du" (informal).

| Value | DeepL | LLM providers |
| --- | --- | --- |
| `more` / `less` | Sent only to languages that support it (today: German, Spanish, French, Italian, Japanese, Dutch, Polish, Portuguese, Russian). Other locales use the default, with a note. | "Tone: formal" / "Tone: informal" in the prompt |
| `prefer_more` / `prefer_less` | Always sent. DeepL uses it where it can and falls back by itself. | same as `more` / `less` |
| `default` (or no flag) | DeepL's default | no tone line |

Example:

```bash
npx ext-localize translate --provider deepl --to de,fr,ar --formality more
# ar: formality "more" is not supported for AR; using the default
# de: created DeepL glossary "ext-localize en->de 965861d7c05511be" (3 terms)
```

Changing `--formality` or the glossary does not re-translate existing strings by itself (only source changes do). Add `--force` once to apply the new tone or terms to everything.

## Exit codes

| Code | `translate` | `check` | `push` |
| --- | --- | --- | --- |
| `0` | every string written (or `--dry-run`) | no errors (and no warnings with `--strict`) | done (dry run, files written, or sent) |
| `1` | some strings failed, or the run stopped early (also a missing API key) | errors found | errors in the listing, the send failed, `--copy` could not verify the clipboard, or `--auto` did not finish cleanly |
| `2` | usage error, bad config file, a configured listing folder that does not exist, or the extension or listing cannot be loaded | usage error, bad config file, missing listing folder, unreadable `--zip` | usage error, missing env vars for `--send`, or the listing cannot be loaded |
| `3` | no target locales (use `--to`, or create locale folders) | – | – |

## Store listing

The listing pack is one JSON file per locale in a listing folder. By default that is `listing/` next to `manifest.json`. Set `listing.dir` in the config file, or pass `--listing-dir`, to keep it elsewhere (for example outside the build folder, so it never ships in the zip). A relative `listing.dir` is resolved from the folder that holds `.localizer/` (the extension folder by default); an absolute path is used as is. A configured folder that does not exist is an error (exit 2).

```
listing/en.json      source (the default_locale), written by you
listing/de.json      written by "translate --listing"
listing/pt_BR.json   file names are Chrome locale codes
```

Every file has the same shape (the same contract the store tools use):

```json
{ "name": "TabNest", "summary": "Save and restore tabs.", "description": "Long text..." }
```

In the **source file only**, `description` may also be an array of lines. They are joined with line breaks. This is easier to edit and gives clean git diffs. Keep one sentence on one line: DeepL translates each line on its own, so a sentence split over two lines is translated as two pieces.

```json
{
  "description": [
    "TabNest saves your tabs.",
    "",
    "- Save all open tabs as a session",
    "- Restore them later"
  ]
}
```

**Name and summary stay in sync with `_locales`.** On Chrome, the store name and summary come from the manifest. When `manifest.json` uses `"name": "__MSG_extName__"` (or `"description": "__MSG_extDescription__"`):

- the source file may leave out `name` (or `summary`); it is read from `_locales/<default>/messages.json`;
- `translate --listing` copies the name and summary of each locale from `_locales/<locale>/messages.json`. They are not translated a second time (recorded as `"by": "_locales"`). Only when that locale has no `_locales` folder yet are they translated;
- `check` warns when a listing name or summary differs from `_locales`.

So run `translate` (messages) first, then `translate --listing`.

**Translating.** `translate --listing` uses the same providers, glossary, formality and diff state as messages. Only changed fields are sent again. With no `--to`, it uses the existing `_locales` folders and listing files. The rules differ a little from messages:

- `$` has no meaning in listing text. `$4.99` is plain text, and a hand edit like `4,99 €` is kept (not marked broken). Glossary `keep` terms are still protected.
- LLMs get a listing prompt (keep paragraphs, line breaks and list markers; natural marketing text; no added claims) and the length limit of each field.
- A translation longer than the limit of your stores is not written; it is listed as failed.
- A description too long for one model answer fails for that locale only and does not stop the run.

### Listing checks

`check` validates `listing/` when the folder exists:

| Level | Rule |
| --- | --- |
| error | No source file `listing/<default_locale>.json`, a file that does not parse, a file name that is not a Chrome locale code, a field that is not a string, a missing or empty field |
| error | Over a store limit (characters, counted as Unicode code points) for the chosen stores |
| warning | Name or summary differs from `_locales` (when the manifest uses `__MSG_`) |
| warning | Unknown fields |
| warning | Firefox: `#` heading lines in the description (AMO drops Markdown headings), a URL in the summary |
| warning | Edge: description shorter than 250 characters |

| Store | name | summary | description |
| --- | --- | --- | --- |
| `chrome` | 75 | 132 | 16,000 (the dashboard field's `maxlength`; not in Google's docs) |
| `firefox` | 50 | 250 | 15,000 (AMO returns HTTP 400 above these) |
| `edge` | from the manifest | from the manifest | 250 to 10,000 (Partner Center) |

## Delivering the listing to the stores

### `push firefox` (Firefox Add-ons, real API)

```bash
ext-localize push firefox --addon <id|slug|guid>              # dry run: prints the request
AMO_JWT_ISSUER=... AMO_JWT_SECRET=... ext-localize push firefox --addon my-addon --send
```

- **Dry run is the default.** It prints the `PATCH` URL, the JSON body, which listing file fed each AMO locale, and the locales that **cannot be sent**. A real send needs `--send` **and** both `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (create them at https://addons.mozilla.org/en-US/developers/addon/api/key/). The secret is never printed or written.
- One `PATCH /api/v5/addons/addon/<id>/` sets `name`, `summary` and `description` for all locales. Locales you do not send are not changed.
- AMO accepts only 44 locales today. Of the 55 Chrome locales, 33 map and 22 are skipped with a reason (for example `ar`, `bg`, `id`, `hi`, `th`, `fil`, `en_AU`). `es_419` is copied to `es-AR`, `es-CL` and `es-MX`; `no` goes to `nb-NO`. Use `--extra-locales` if AMO adds more.
- Any error (too long, empty, two files for one AMO locale) stops the send before any request.
- `--host <url>` sends to another AMO server, for example the stage server for a test. Default: `https://addons.mozilla.org` (or `firefox.host` in the config).
- `--remove de,fr` also deletes those AMO locales (sends `null`). The AMO default locale can never be removed; it is taken from `default_locale` (`en` becomes `en-US`), or set it with `--default-locale`.
- Changing `name` or `summary` starts an AMO content review. The new text is saved at once and reviewed later.
- The description is Markdown on AMO: `- item` lists become real lists, `# headings` are dropped.

### `push chrome` (one paste, the default)

Chrome has no API for listing text. Name and summary come from your manifest (`_locales`). Only the "Detailed description" is typed per language in the dashboard.

```bash
ext-localize push chrome --copy
```

This writes `.localizer/out/chrome-paste.js` (and a read-only `chrome-diagnose.js`) and prints its size. With `--copy`, it puts the script on the macOS clipboard, reads it back, and fails (exit 1) unless the clipboard holds exactly the file. Then:

1. In Chrome, open the Developer Dashboard, your item, and its "Store listing" tab.
2. Open the DevTools console: Cmd+Option+J.
3. Paste and press Enter. The first time, Chrome may ask you to type `allow pasting`.
4. The script switches to each language, fills the description, then checks every language again and prints a report.
5. Look at a few languages, then click **Save draft** yourself.

**The script cannot be damaged on the way.** It is pure ASCII: every non-ASCII character in the descriptions is written as a `\uXXXX` escape. (Before 0.2.1, `--copy` in a shell with no UTF-8 locale put garbled text on the clipboard; see the CHANGELOG.) Each description also carries its length in characters and a short SHA-256 hash, computed from the listing files. Before filling, the script checks every embedded text against them and fills **nothing** if one differs. After filling, it checks the page text against them too. The report shows `length`, `wantLength` and `sha` per language.

**Size:** about 19 KB of code plus the descriptions. Latin text stays the same size; non-Latin text grows about 6 times (each character becomes a 6-byte escape). Measured: 32 languages of 4,000 characters are 147 KB when all Latin and 772 KB when all non-Latin; a real mix lands in between. A 216 KB paste worked in the Chrome console; pastes near 800 KB have not been tried on the real dashboard. `push chrome` prints the size.

The script never clicks Submit for review or Publish. Use `--mode save-each` if the dashboard ever drops unsaved text when you switch language (then the script waits for your Save draft click after each language). `.localizer/out/` gets its own `.gitignore`. `--out <file>` writes the paste script somewhere else.

### `push chrome --auto` (EXPERIMENTAL)

> **Warning.** `--auto` drives the Chrome Web Store dashboard from a script over the Chrome DevTools Protocol. **Google has not confirmed that this is allowed.** The Developer Agreement (section 4.4.2) forbids access "by any means other than through the interface", and it is unclear whether a script that clicks the same interface counts. **Your publisher account is what is at risk.** The default above (one paste, you click Save) is the lower-risk way. Every `--auto` run prints this warning.

The spike this is ported from worked on a real test item (fill 16 languages, Save draft, reload, read back, a 15,000-character text). This CLI port has only run against a local mock of the dashboard so far. It needs Playwright, which is **not** installed by default:

```bash
npm install playwright-core      # uses your installed Google Chrome, no browser download
```

Steps:

1. Sign in once in a separate Chrome profile (Chrome blocks automation of your everyday profile):
   ```bash
   ext-localize push chrome --auto --login     # opens plain Chrome on ~/.ext-localize/chrome-profile; sign in, then quit it
   ```
2. Fill only (nothing is saved; reload the page to undo):
   ```bash
   ext-localize push chrome --auto --item <32-letter item id>
   ```
3. Fill, save and check:
   ```bash
   ext-localize push chrome --auto --item <id> --save
   ```

Guards:

- `--item` is required, and the tool only touches a tab that shows that item (on `chrome.google.com` or `chromewebstore.google.com`). If no tab shows it, a window opens and waits for you to open the item.
- It never clicks Publish or Submit for review. It clicks only one button named exactly "Save draft", and only with `--save`.
- **Every item counts as live** unless you list it in `chrome.testItems` in the config file. Saving on any other item also needs `--allow-live`.
- After saving, it reloads the page and reads every language back. The exit code is `1` if anything differs.
- A report goes to `.localizer/out/chrome-auto-<date>.json`. Network traffic is never recorded (the save request carries session tokens).
- `--profile <dir>` uses another Chrome profile folder with `launch` (default `~/.ext-localize/chrome-profile`, or `chrome.profile` in the config). Sign in there once with `--login`.
- `--url <url>` opens this page first instead of the dashboard, and `--headless` runs Chrome without a window. Both are for testing against a local copy of the dashboard.
- `--browser port:9222` attaches to a Chrome you started with `--remote-debugging-port=9222 --user-data-dir=<separate folder>` instead. Quit that Chrome after the run: while the port is open, any program on your Mac can control it.

### `listing import` (existing descriptions)

If you already have one description file per language, turn them into listing files:

```bash
ext-localize listing import store/descriptions               # files named <locale>.txt
ext-localize listing import 'store/descriptions/desc-{locale}.txt'
```

Locale codes in file names are normalised (`pt-BR` becomes `pt_BR`); unknown codes are skipped. Name and summary are copied from `_locales` when the manifest uses `__MSG_`. Existing listing files are kept unless you add `--force`. Imported files have no state yet, so the next `translate --listing` adopts them instead of translating them again.

### `push edge` (copy-ready files)

Edge has no API for listing text, so this writes `.localizer/out/edge/<locale>.txt` with the description of each locale, and `--print` prints copy-ready blocks. In Partner Center, open the extension, "Store listings", pick each language and paste. The extension name and short description are read from the manifest there, so they are not in these files. Descriptions under 250 or over 10,000 characters are reported (exit code `1`). How Partner Center names each language is not documented; match by language name.

## Config file

Flags get long, so defaults can go in `.localizer/config.json`. Flags always win. Unknown keys are an error (so a typo does not silently do nothing).

**Projects without a manifest in source (WXT, Plasmo, CRXJS).** The manifest exists only in the build output, and the build wipes that folder. Keep the tool's own files in the repository and point `--config` at them:

```bash
ext-localize translate --dir .output/chrome-mv3 --config .localizer/config.json --to de,fr
ext-localize push chrome --dir .output/chrome-mv3 --config .localizer/config.json --copy
```

With `--config <file>`, `state.json`, `glossary.json` and `out/` are read and written next to that file, and relative paths inside it (`listing.dir`, `locales.dir`, `manifest`, `glossary`) are resolved from the folder that holds its folder (here: the repository). Add `--locales-dir` (or config `locales.dir`) so `check` and `translate` read and write your source `_locales` instead of the copy in the build:

```bash
ext-localize translate --dir .output/chrome-mv3 --config .localizer/config.json --locales-dir public/_locales --to de,fr
```

With `"locales": { "dir": "public/_locales" }` in that config file the flag is not needed. File paths in reports are relative to `--dir` (for example `../../public/_locales/de/messages.json`).

`manifest.json` is read from `--dir` by default. To work before the first build (or in CI without a build step), point `--manifest` (or config `manifest`) at a manifest file you keep in the repository. Only `default_locale`, `name`, `short_name`, `description` and the `__MSG_` references are read from it, so it can be a small file that matches what your build generates:

```json
{ "manifest_version": 3, "name": "__MSG_extName__", "description": "__MSG_extDescription__", "version": "0", "default_locale": "en" }
```

`push chrome --zip` and `check --zip` compare with the package you upload, not with `--locales-dir`. Without a listing folder, `--zip` has nothing to compare and reports nothing.

Working examples for both frameworks, built and loaded in Chromium, are in [`examples/`](https://github.com/Tigrandza/ext-localize/tree/main/cli/examples): WXT (`public/_locales`; WXT takes the toolbar tooltip from the popup's `<title>`, so write `<title>__MSG_actionTitle__</title>` there) and Plasmo (`locales/`, copied to `_locales` by the build).

```json
{
  "provider": "deepl",
  "model": "claude-opus-5-5",
  "effort": "medium",
  "formality": "prefer_more",
  "to": ["de", "fr", "pt-BR"],
  "glossary": ".localizer/glossary.json",
  "stores": ["chrome", "firefox"],
  "listing": { "dir": "listing" },
  "manifest": "manifest.json",
  "locales": { "dir": "public/_locales" },
  "check": { "ignoreKeys": ["appShortName", "ui_size_*"], "missingKeys": "warning" },
  "firefox": { "addon": "my-addon", "defaultLocale": "en-US", "extraLocales": [], "host": "https://addons.mozilla.org" },
  "chrome": { "item": "<32-letter id>", "publisher": "<publisher id>", "testItems": ["<id>"], "browser": "launch", "profile": "~/.ext-localize/chrome-profile" }
}
```

| Key | Used by | Meaning |
| --- | --- | --- |
| `provider`, `model`, `effort`, `formality`, `to` | `translate` | Same as the flags. `to` may be a string or a list. |
| `glossary` | `translate` | Relative to the folder that holds `.localizer/` (the extension folder by default), or absolute. |
| `stores` | `check`, `translate --listing` | Whose listing limits apply. Default `["chrome"]`. |
| `listing.dir` | all listing commands | Default `listing`. Relative to the folder that holds `.localizer/`, or absolute. Must exist when set. |
| `manifest` | all commands | Default `manifest.json` in the extension folder. Relative to the folder that holds `.localizer/`, or absolute. Must exist when set. `--manifest` wins (relative to the current folder). |
| `locales.dir` | all commands | Default `_locales` in the extension folder. Relative to the folder that holds `.localizer/`, or absolute. Must exist when set. `--locales-dir` wins (relative to the current folder). |
| `check.ignoreKeys` | `check` (and the check after `translate`) | Key patterns whose issues are dropped. `*` is the only wildcard; case-insensitive. |
| `check.missingKeys` | `check` (and the check after `translate`) | `error` (default) or `warning` for keys missing in a non-default locale. |
| `firefox.*` | `push firefox` | Add-on id, AMO default locale, extra accepted locales, host (for example the stage server). |
| `chrome.item`, `chrome.publisher` | `push chrome --auto` | Item id; with the publisher id the tool opens the item page itself. |
| `chrome.testItems` | `push chrome --auto --save` | Items you may save on without `--allow-live`. |
| `chrome.browser`, `chrome.profile` | `push chrome --auto` | `launch` or `port:<n>`; profile folder for `launch`. |

Keys (API keys, AMO secrets) never go in this file. They are read from the environment only.

## Sample extension

`fixtures/sample-extension/` is a small realistic extension (a tab manager) with 25 messages. It has named and positional placeholders, `$$` prices, descriptions, a line break, comments in `manifest.json`, a glossary, a source listing (`listing/en.json`, description as lines, name and summary from `_locales`) and a config file. Try:

```bash
node src/cli.ts translate --dir fixtures/sample-extension --to all --dry-run
node src/cli.ts translate --listing --dir fixtures/sample-extension --to de,fr --dry-run
node src/cli.ts check --dir fixtures/sample-extension --store chrome,firefox,edge
node src/cli.ts push firefox --dir fixtures/sample-extension
```

## Development

```bash
npm install
npm test           # node:test, no API calls (providers and AMO are mocked)
npm run typecheck
npm run build      # writes dist/ (npm pack runs it too, via "prepack")
```

The Chrome tests run the paste script and `--auto` against a local mock of the dashboard (`test/chrome-mock/`, a React page that copies only what makes automation hard). They need Google Chrome in `/Applications` and the `playwright-core` dev dependency; otherwise they are skipped.

## Not done yet

- Tested live with DeepL and with Ollama (qwen3:8b on macOS, 10 small extensions into es, de and ja, 0 errors), only for `_locales` messages. The Anthropic and OpenAI providers are covered by unit tests with mocks, but have not been run against the real APIs yet. Listing translation (long descriptions, line-by-line DeepL) has only run against mocks.
- `push firefox --send` has run once against the real AMO (27 November 2026, an unlisted test add-on): HTTP 200, name, summary and description saved in 6 AMO locales, with `es_419` copied to `es-AR`, `es-CL` and `es-MX`. Not yet tried on a listed add-on, where name and summary changes go to content review.
- `push chrome --auto` in this CLI has only run against the local mock. The code is a port of the spike that worked on a real test item. Google has not answered whether it is allowed, so it stays experimental.
- The paste script is the spike's fixed version that worked on the real dashboard (16 languages, matched by language code); a later dashboard change can break it, and it fails loudly when it does.
- No screenshots: per-language store images are not handled.
- Edge: how Partner Center names languages is not documented, so files are named by Chrome code.
- Plural families: `translate` does not create forms the source lacks (`_few`, `_many`). A missing key in a non-default locale is an error by default; set `check.missingKeys` to `"warning"` to relax it.
- `--manifest` reads a manifest file you keep by hand; the tool does not read `wxt.config.ts` or a Plasmo `package.json` to build one, so keep that file in step with your build.
- `--dry-run` does not know which locales DeepL or AMO will skip, and counts them.
- `dist/` has not been run on a real Node 20 yet (checked by compiler settings and a code scan only).
- The GitHub Action (`action/`) and the sync service are separate work.
