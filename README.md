# ext-localize

Translate a Chrome extension into every store language, check that no locale is broken, and keep it that way after every release.

Most extensions ship in one language. Chrome makes the rest hard: a single bad comma in a `messages.json` makes Chrome drop that whole language **without any error**, the store listing text has no API, and every release adds strings that nobody re-translates. This repository holds two tools that fix that, both free and open source, and both run on your own machine or your own CI.

| Folder | What it is |
| --- | --- |
| [`cli/`](cli/README.md) | **`ext-localize`**, the command-line tool. On npm: `npx ext-localize`. |
| [`action/`](action/README.md) | A GitHub Action that runs the CLI on every push: fails the build on a broken or stale locale, and can open a pull request with new translations. |

## What it does

- **Finds broken locales Chrome hides from you.** `ext-localize check` reads every `_locales/*/messages.json` and reports invalid JSON, missing keys, broken `$PLACEHOLDERS$`, wrong plural forms, store listing text that is too long, and translations that are older than their English source. It exits with an error, so CI can stop the release.
- **Translates only what changed.** It remembers a hash of each source string. The next run sends only new and changed strings to the translator, and leaves the rest alone.
- **Your key, your choice of translator.** Anthropic, OpenAI, DeepL, or a local model through Ollama. Nothing leaves your machine except the strings you send to the provider you picked. There is no server of ours in between.
- **Store listings too.** Name, summary and long description in every language, checked against each store's length limits. Then: one API call for Firefox Add-ons, one paste into the dashboard for the Chrome Web Store, copy-ready files for Edge.

## Quick start

In your extension folder (the one with `manifest.json` and `default_locale`):

```bash
npx ext-localize check                                  # is every locale valid?
npx ext-localize translate --to de,fr,ja --dry-run      # what would be translated? no API calls
export DEEPL_API_KEY=...                                # or ANTHROPIC_API_KEY / OPENAI_API_KEY
npx ext-localize translate --provider deepl --to de,fr,ja
```

Commit `_locales/` and `.localizer/state.json`. Next release, run `translate` again and only the changed strings are sent.

The full guide, every option and the store delivery steps are in [`cli/README.md`](cli/README.md). To run the check in CI, see [`action/README.md`](action/README.md).

## Status

- `ext-localize` 0.3.0 is on npm and is tested on Node 20, 22 and 24. See the [changelog](cli/CHANGELOG.md).
- Firefox delivery uses the official AMO API. Chrome has no API for listing text, so the default is a script you paste into the dashboard yourself. A fully automatic Chrome mode exists behind `--auto`, marked **experimental**: Google has not said whether it is allowed, and your publisher account is what is at risk. Read the warning in the CLI README before you use it.
- Screenshots in other languages are not done yet.

## Development

```bash
cd cli && npm install && npm test        # CLI tests (Node 22.18+ runs the TypeScript directly)
cd action && npm test                    # Action tests, no dependencies
```

No test calls a paid API. Provider calls go to fake local servers.

## License

MIT. See [LICENSE](LICENSE).
