# Release verification

This file records author-side release evidence. Workshop verification and Registry admission remain independent maintainer decisions.

## Supported baseline

- DeepSeek Harness: `0.1.1-rc.2`
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
- the packed file list contains every path declared by `main`, `types`, `exports`, and `files`;
- consumer installation does not run `prepare`.

The release workflow repeats this gate before npm publication. Failure-isolation, hot-reload, removal, and current Workshop-baseline evidence remain `null` until the Workshop harness records them.
