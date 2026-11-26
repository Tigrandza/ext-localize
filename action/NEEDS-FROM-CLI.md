# What the Action needs from the CLI

Status on 17 November 2026, against CLI 0.2.0 in `cli/`.

## Done (the Action now uses them, and its workarounds are gone)

| # | Need | How the Action uses it now | Workaround removed |
| --- | --- | --- | --- |
| 1 | Stale strings in `check` | Maps its `stale` input to `check --stale=error\|warning\|off`. Reads `stale`, `staleCheck` and issues with `kind: "stale"` | `scripts/lib/stale.mjs` (its own copy of the hash recipe and state reader) and its tests |
| 2 | `translate --json` | The PR body, the job summary and the failure count come from `locales`, `failedKeys`, `totals`, `stopped`, `check` and `error` | Parsing the text table and the `FAILED  ` lines; the extra `check` run after translating |
| 3 | Exit code for "no target locales" | Exit `3` (or `noTargets: true`): the job passes, no PR, and the summary says to set `to` | Treating it as a failure |
| 4 | `file` and `line` per issue | Annotations use them, with the `path` input in front | Building the path from `locale` and searching the file for the key |
| 5 | List of files `translate` writes | Commits exactly `filesWritten`, after checking each path against `mayWrite`. New input `listing: true` runs `translate --listing` after the messages and commits `listing/<locale>.json` | The fixed list `_locales` + `.localizer/state.json` |
| 6 | `bin` -> `dist/cli.js`, tarball works | `cli-version` default is now `0.2.0` | – |
| 7 | Run before npm publish | New `cli-source: bundled` runs `action/../cli` from the same commit. Verified on a GitHub-hosted runner | – |

## Still open

### A. Publish to npm

`cli-source: npm` stays the default for the future, but it cannot work until `ext-localize@0.2.0` (or newer) is on npm. Until then, users need `cli-source: bundled`.

### B. Optional: a single-file bundle

`cli-source: bundled` works on a GitHub-hosted runner (checked on 17 November 2026: GitHub downloads the whole repository, so the CLI was at `/home/runner/work/_actions/<owner>/<repo>/<ref>/cli`). It still runs `npm ci --omit=dev` there, so it needs the npm registry. A committed, dependency-free bundle (one `dist/cli.js` with the Anthropic SDK included) would remove that step. Nice to have, not a blocker.

### C. Small things, nice to have

- `check --json` has no field that tells the Action which CLI version made it. A `version` field would let the Action give a clear message instead of "could not run" when someone pins an old CLI that does not know `--stale`. Today an old CLI exits 2 on the unknown flag, and the Action reports "check could not run".
