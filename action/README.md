# ext-localize GitHub Action

Keep the `_locales/` of a Chrome extension correct and up to date in CI.

- **`mode: check`** (default) fails the build when a locale is broken or incomplete, or when a translation is **stale**. Stale means the source text changed after the string was translated.
- **`mode: translate`** translates new and changed strings with your own provider key, commits them to a bot branch, and opens one pull request. If that PR is already open, the Action updates it.

It runs the [`ext-localize`](../cli/README.md) CLI. Your strings go only to the provider you choose (or to Ollama on your own machine). The Action sends nothing anywhere else.

## Quick start

### 1. Check on every push and pull request

`.github/workflows/locales.yml` (also in [`examples/check.yml`](examples/check.yml)):

```yaml
name: Locales
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: Tigrandza/ext-localize/action@v0.3.1
        with:
          path: .          # folder with manifest.json
          stale: fail      # or "warn" while you catch up
```

The job fails when `check` finds an error, or when a string is stale. It also checks the store listing (`listing/`) if you have one. You get:

- a table in the job summary,
- annotations on the right file and line, as reported by the CLI (GitHub shows the first 10 errors and 10 warnings per step),
- outputs `result`, `errors`, `warnings` and `stale`.

Check mode needs no secrets, so it also works for pull requests from forks.

### 2. Translate on demand, or when the source changes on main

`.github/workflows/translate.yml` (also in [`examples/translate.yml`](examples/translate.yml)):

```yaml
name: Translate
on:
  workflow_dispatch:
    inputs:
      to:
        description: 'Target locales, for example "de,fr,ja" or "all". Empty: existing folders.'
        required: false
        default: ""
  push:
    branches: [main]
    paths:
      - "_locales/en/messages.json"
permissions:
  contents: write
  pull-requests: write
concurrency:
  group: ext-localize-translate
  cancel-in-progress: false
jobs:
  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Tigrandza/ext-localize/action@v0.3.1
        with:
          cli-source: bundled   # until ext-localize is on npm
          mode: translate
          provider: deepl
          to: ${{ inputs.to }}
        env:
          DEEPL_API_KEY: ${{ secrets.DEEPL_API_KEY }}
```

Before the first run:

1. Add the provider key as a repository secret (Settings > Secrets and variables > Actions). In the example it is `DEEPL_API_KEY`.
2. Turn on the required setting below.
3. Pin the Action to a release tag (`@v0.3.1`) or, safer, to a full commit SHA.

> **Required setting.** Settings > Actions > General > Workflow permissions > "Allow GitHub Actions to create and approve pull requests". It is **off by default**. While it is off, the Action pushes the branch `ext-localize/translations` and then GitHub refuses the PR (`GitHub Actions is not permitted to create or approve pull requests`). The job then fails with `result: pr-blocked` and an error that names the branch and this setting. Your translations are safe on that branch: turn the setting on and run the workflow again, or open the PR by hand. For a repository in an organization, the organization's own Actions settings may also block it, and an organization owner has to allow it there first.

What happens on each run:

1. `ext-localize translate --json` runs. Only new and changed strings are sent to the provider. With `listing: true`, `translate --listing --json` runs next (messages first, because the listing copies the name and summary from `_locales`).
2. If the CLI wrote no file, the run ends. No PR. If there are no target locales (CLI exit code 3), the job still passes and the summary says to set `to`.
3. Otherwise the Action commits exactly the files the CLI reports in `filesWritten`, after checking each one against the CLI's own `mayWrite` list. Today that is `_locales/<locale>/messages.json`, `listing/<locale>.json` and `.localizer/state.json`. It commits to the branch `ext-localize/translations`, force-pushes that branch, and opens a PR to the default branch. If that PR is already open, the Action updates its title and text.
4. The PR text has a table per locale, the strings that failed, and the result of the `check` the CLI ran after translating.

## Inputs

| Input | Mode | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | both | `check` | `check` or `translate` |
| `path` | both | `.` | Extension folder (with `manifest.json`), relative to the repo root |
| `stale` | check | `fail` | `fail`, `warn` or `ignore` |
| `strict` | check | `false` | `true` also fails on warnings |
| `annotations` | check | `true` | Add annotations to files |
| `store` | both | config, else `chrome` | Stores whose listing limits apply, for example `chrome,firefox` |
| `provider` | translate | config | `anthropic`, `openai`, `deepl` or `ollama` |
| `to` | translate | config, else existing folders | `de,fr,pt-BR` or `all` |
| `model` | translate | | Model id. Required for `openai` and `ollama` |
| `formality` | translate | | `default`, `more`, `less`, `prefer_more`, `prefer_less` |
| `dry-run` | translate | `false` | Only show the plan. No API calls, no commit, no PR |
| `listing` | translate | `false` | Also translate the store listing (`listing/<locale>.json`), in the same PR |
| `branch` | translate | `ext-localize/translations` | Branch the Action owns |
| `base` | translate | default branch | PR base |
| `pr-title` | translate | `Update translations (ext-localize)` | |
| `github-token` | translate | `github.token` | Token for `gh` (see below) |
| `cli-source` | both | `npm` | `npm`, `bundled`, or a path to a copy of the CLI. See [Where the CLI comes from](#where-the-cli-comes-from) |
| `cli-version` | both | `0.3.1` | npm version when `cli-source` is `npm`. Needs 0.2.0 or newer; 0.2.1 fixes the garbled clipboard copy, 0.3.0 adds `--locales-dir` and `--manifest`, 0.3.1 tells the model the store length limits |
| `node-version` | both | `24` | Set up this Node version. Empty: use the runner's Node. Note: `actions/setup-node` changes Node for the **rest of the job** too, not only this step. Set `""` if your later steps need another version |

"config" means `.localizer/config.json` in the extension folder. Inputs win over the config file.

## Outputs

| Output | Meaning |
| --- | --- |
| `result` | `pass`, `fail`, `partial` (some strings failed), `no-targets`, `dry-run`, `pr-blocked` (branch pushed, but GitHub did not allow the PR; see [Required setting](#2-translate-on-demand-or-when-the-source-changes-on-main)) or `error` |
| `errors`, `warnings` | Counts from `check` |
| `stale` | Number of stale strings. Empty when it could not be checked |
| `changed` | `true` when translations were committed |
| `pr-url`, `pr-number` | The created or updated PR |

## Stale strings

`ext-localize translate` stores a hash of every source string in `.localizer/state.json`. `ext-localize check --stale=...` compares those hashes with the current source text. The Action maps its `stale` input to that flag: `fail` = `--stale=error`, `warn` = `--stale=warning`, `ignore` = `--stale=off`.

Example: you change `"Restore"` to `"Restore now"` in `_locales/en/messages.json`. The German text was made from `"Restore"`, so `de > buttonRestore` is stale until you translate again.

- Editing only a `description` does not make a string stale.
- Without a committed `state.json`, stale strings cannot be checked. The summary says so, and the job does not fail for that.
- Strings that existed before the first `translate` run have no hash yet. The summary counts them as "untracked".
- If `state.json` does not parse, or has an unknown version, `stale: fail` fails the job. It does not pass silently.
- Stale strings count as errors (`fail`) or warnings (`warn`) in the `errors` and `warnings` outputs. `stale` gives their number on its own.

## Secrets

- Pass the provider key as `env` on the step, as in the example. The CLI reads it from the environment. Do not pass it as an input.
- The Action never prints the environment. A test checks that the key is not in the log or the summary.
- Key names: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (and `OPENAI_BASE_URL`), `DEEPL_API_KEY`, `OLLAMA_HOST`.
- Inputs reach the script through environment variables, never through the script text, so an input cannot inject shell code. CLI flags are checked and passed as `--flag=value`.

### Privacy: local models

To keep strings on your own hardware, run the job on a [self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners) with Ollama, and use `provider: ollama`, `model: <your model>` and `OLLAMA_HOST`. Or point `OPENAI_BASE_URL` at a local OpenAI-compatible server (LM Studio, vLLM, llama.cpp) with `provider: openai`.

## Things to know about translate mode

- **It never pushes to the default branch.** It refuses a `branch` that is the default branch, the PR base, the branch the workflow runs on, `main` or `master`.
- **It runs only on the PR base branch.** The bot branch is built on top of the checked-out commit. If the workflow runs on `feat` but the PR goes to `main`, the PR would also carry every commit of `feat`. So the Action stops with an error. Run it on the base branch, or set `base`.
- **It does not run on `pull_request` events.** That code may come from a fork. Use `push`, `workflow_dispatch` or `schedule`.
- **The bot branch is rebuilt on every run.** Commits that people push to `ext-localize/translations` are overwritten. To fix a translation, merge the PR and edit the file on the default branch. The CLI keeps hand edits.
- **Some strings failed:** the PR still opens with the strings that worked. The job ends red, and the PR text lists the failed keys with the reason. The next run tries them again.
- **A later step failed** (for example the listing run): what the earlier run wrote is still committed, because those strings are already paid for. The job ends red.
- **Provider, model, locales and formality** can come from `.localizer/config.json`. Then `provider` and `to` may stay empty.
- **A PR opened with `GITHUB_TOKEN` does not start other workflows.** Your check workflow will not run on the bot PR by itself. The PR text already shows the `check` result. If you need the other workflows to run, use a GitHub App token or a fine-grained personal access token:
  1. Pass it to `actions/checkout` as `token:`. Git uses it for the push.
  2. Pass it to this Action as `github-token:`. `gh` uses it for the PR.
- **Use `concurrency`** (as in the example), so two runs do not push the same branch at once.
- The bot commits as `github-actions[bot]`.
- CLI output is printed with workflow commands turned off (`::stop-commands::`), so a key name in your files cannot inject a `::command::` into the log.

## Why a composite action

A composite action runs shell steps on the runner. A JavaScript action runs one bundled Node file.

This Action is mostly "run a CLI, then run `git` and `gh`". A composite action does that directly, and it can use `actions/setup-node` to get a Node version the CLI needs. A JavaScript action would need `@actions/core` and a committed, bundled `dist/` for little gain. The scripts here are plain Node `.mjs` files with **no dependencies**, so nothing needs building or bundling. The only other action used is GitHub's own `actions/setup-node`, and you can turn it off with `node-version: ""`.

The cost: composite actions have no `post:` step, and inputs must be passed by hand. Neither matters here.

## Where the CLI comes from

- `cli-source: npm` (default) runs `npx --yes ext-localize@<cli-version>` from npm. The default `cli-version` is pinned (see `action.yml`), so a new CLI release never changes your build until you raise it.
- `cli-source: bundled` runs the `cli/` folder from the same commit as the Action (`action/../cli`). Use it to try an unreleased CLI change. On the first run the Action installs the CLI's runtime dependencies there (`npm ci --omit=dev --ignore-scripts`, so the runner needs access to the npm registry). It works on a GitHub-hosted runner: GitHub downloads the whole repository for `uses: Tigrandza/ext-localize/action@ref`, so the CLI is next to the Action (checked on 17 November 2026 with a self-test workflow in a private repo).
- `cli-source: <path>` runs a copy of the CLI inside your repository. It uses `src/cli.ts` on Node 22.18+, else `dist/cli.js`, and installs dependencies the same way.

Example, to run the CLI from the same commit as the Action:

```yaml
      - uses: Tigrandza/ext-localize/action@v0.3.1
        with:
          cli-source: bundled
```

## Development

```bash
cd action
npm test            # all tests, no network beyond 127.0.0.1, no paid APIs
npm run test:unit
npm run test:e2e
```

The tests need Node 22.18+ (they read the CLI's TypeScript source). No `npm install` is needed: there are no dependencies.

The end-to-end tests:

- copy `cli/fixtures/sample-extension/` into a temp folder (the original is never changed),
- create a throwaway git repo with a bare "origin" in the OS temp folder,
- run the real CLI through `scripts/main.mjs`, as the runner would, with `cli-source: bundled` (and once with a path),
- translate with the CLI's `openai` provider pointed at a fake server on 127.0.0.1,
- use a fake `gh` script that records its calls.

They cover: check pass and fail, stale fail, warn and ignore, broken placeholders, translate with PR create, PR update, dry run, `listing: true`, no target locales (exit 3), a CLI error result, refusing `pull_request` events and other branches, GitHub blocking PR creation (`pr-blocked`), log injection through key names, bad inputs, and that the key is never printed.

The test helper removes every `*_API_KEY` variable from the environment, so a real key in your shell never reaches the CLI during tests.

## Not verified yet

- **Real GitHub runs: one repo only.** On 17 November 2026 a self-test workflow in a private repo ran check mode (passed) and translate mode with `cli-source: bundled`. Translate first hit the "not permitted to create or approve pull requests" error. After the setting was turned on, it opened a correct PR. The new `pr-blocked` message itself has only run in the local tests (with a fake `gh` that returns that error). As far as I know, these were not tried on GitHub yet: an organization repo, `listing: true`, updating an open PR, and `schedule` events.
- **`actionlint` was not run.** It is not installed on this machine. `action.yml` and the examples were parsed with Ruby's YAML parser, and a script checked that every input is wired through.
- **`cli-source: npm`** (the default) is checked on GitHub-hosted runners by the self-test workflow with the published package (0.3.1). Not tried on self-hosted runners.
- **`cli-source: bundled`** is verified on a GitHub-hosted runner (see above). Not tried on self-hosted runners, or with no access to the npm registry.
- **Windows runners** are not supported: the step uses `bash`, and the tests use Unix paths.
- **Forgejo or Gitea Actions:** probably not. `gh` only talks to GitHub.

See [NEEDS-FROM-CLI.md](NEEDS-FROM-CLI.md) for what is still open on the CLI side.
