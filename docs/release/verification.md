# Release verification

This file records author-side release evidence. Workshop verification and Registry admission remain independent maintainer decisions.

## M5 development build: 0.3.10-dev.0

This development package requires the matched M5 Harness receipt, admission, and tool APIs. The older baseline below records earlier releases only. Its source worktree is `codex/m5-reference-settlement`; paired commits and package hashes are recorded by `dsh-codex-runtime/docs/release/m5-release.json`.

Type checking and the Host/Client build passed. Focused regressions cover saved versus accepted input, draft retention, no duplicate submission, inherited snapshot reads, late backlink deletion, and durable cleanup. A real Codex task used the scoped reference tools through the actual Obsidian HTTP handler against a temporary note; the final keyless composition also passed native acceptance, backlink creation, deletion, and continuation. The actual Vault and RC1 installation remain untouched; user acceptance is pending.

## Historical supported baseline

- DeepSeek Harness client: `0.1.2-alpha.1`
- Profile: `web`
- Node.js: 22 or later
- Package manager: pnpm 11

## Clean-checkout gate

Run from a clean checkout with no pre-existing `lib/` directory:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm pack --dry-run --json
```

Acceptance criteria:

- installation does not require a local path dependency;
- `pnpm test` builds the bundle before bundle-contract tests run;
- all tests pass;
- client projection tests exercise the native `uiConversation.events` and Session-store contracts;
- the packed file list contains every path declared by `main`, `types`, `exports`, and `files`;
- the packed registry artifact contains prebuilt output and remains usable when consumer install scripts are disabled.

The repository retains `prepare` only so a development dependency pinned to a full Git commit can build its untracked `lib/` output. Registry consumers use the prebuilt tarball and do not depend on that lifecycle script.

The release workflow repeats this gate before npm publication. Failure-isolation, hot-reload, removal, and current Workshop-baseline evidence remain `null` until the Workshop harness records them.
