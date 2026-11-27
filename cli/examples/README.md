# Examples: WXT and Plasmo

Two small extensions that use `ext-localize` with a build framework. In both, the
manifest exists only in the build output, so the tool reads a small manifest stub
from `.localizer/manifest.json` and works **before the first build** (and in CI
without a build step).

| | WXT | Plasmo |
| --- | --- | --- |
| Source `_locales` | `public/_locales/` | `locales/` |
| Build output | `.output/chrome-mv3/` | `build/chrome-mv3-prod/` |
| Store zip | `npm run zip` → `.output/*-chrome.zip` | `npm run package` → `build/chrome-mv3-prod.zip` |
| Config | [`wxt/.localizer/config.json`](wxt/.localizer/config.json) | [`plasmo/.localizer/config.json`](plasmo/.localizer/config.json) |

Both were built and loaded in Chromium (WXT 0.21.5, Plasmo 0.90.5, November 2026):
the build copies the translated folders into `_locales`, and the popup shows the
German text when the browser language is German.

## Try it

```bash
cd examples/wxt            # or examples/plasmo
npx ext-localize check --config .localizer/config.json
npx ext-localize translate --config .localizer/config.json --to fr,ja --provider ollama --model qwen3:8b
npm install && npm run build
npx ext-localize check --dir .output/chrome-mv3 --config .localizer/config.json   # Plasmo: build/chrome-mv3-prod
```

`.localizer/` (config, manifest stub, `state.json`, glossary) stays in the repository.
The build folders are wiped on every build, so nothing the tool needs lives there.

## What to keep in sync by hand

The manifest stub must use the same `__MSG_` keys and `default_locale` as the
manifest your build makes. Only `default_locale`, `name`, `short_name`,
`description` and the `__MSG_` references are read from it.

- **WXT:** the manifest comes from `manifest` in `wxt.config.ts`. WXT sets the
  toolbar tooltip (`action.default_title`) from the popup's `<title>`, so put the
  message reference there: `<title>__MSG_actionTitle__</title>`. A
  `default_title` in `wxt.config.ts` is replaced by the `<title>`.
- **Plasmo:** `name` comes from `displayName` and `description` from
  `description` in `package.json`; `default_locale` goes under `manifest`.
  Plasmo copies `locales/<locale>/messages.json` to `_locales` in the build.

## In CI

The GitHub Action reads `.localizer/config.json` from its `path`, so no build
step is needed. With the WXT layout at the repository root:

```yaml
- uses: actions/checkout@v4
- uses: Tigrandza/ext-localize/action@v0.3.0
  with:
    mode: check
    path: .
```
