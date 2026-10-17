# DSH 0.2.1-rc.2 candidate

This candidate targets exactly DSH 0.2.1-rc.2 (687f282e8625c6b8d11ff58211a90524be2e4317). Host APIs are peers, resolved from that current local host for verification; no old host runtime is bundled. Development dependencies are local links because this exact release is not published to npm. The source lockfile records those links.

Annotation protocol 2, Sticker protocol 1 and Bridge lifecycle protocol 3 are unchanged. Existing Obsidian Companion 0.7.0-dsh02.2 remains the protocol counterpart. No Vault binding or sync scope is migrated automatically.

Install as a coordinated set: Core 0.3.12-dsh021.1, Bridge 0.4.1-dsh021.1, Sticker 0.7.4-dsh021.1, ThoughtDAG 0.4.14-dsh021.1; Sticker uses BetterSidebar 0.28.0-dsh021.1 native extension tabs. Host integration uses React 18.3.1; ThoughtDAG's isolated iframe SPA retains its own bundled React 19.

Before installation the main task must back up the exact new instance and stop through the verified Launcher path. The source verification covers types, build, tests and package boundaries. Live instance registration, UI actions and Vault round trips require separate acceptance.

## Reproduce the build

Use a fully built checkout of DSH **0.2.1-rc.2** (official baseline commit `687f282e8625c6b8d11ff58211a90524be2e4317`). Host packages must have their `lib` entries available. The runtime host dependencies are peers; this setup only prepares development links.

From this repository root:

```sh
node scripts/prepare-host.mjs /absolute/path/to/deepseek-harness
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm typecheck
pnpm test
```

Alternatively, set `DSH_HOST_SOURCE` to the built host checkout and run `pnpm prepare:host`. The script checks the exact root version, each referenced DSH package version and its built entry, then creates the ignored `.dsh-host` junction on Windows or directory symlink elsewhere. It reuses an existing link to the same host and refuses an existing unrelated path. No host files are modified. Commit only the stable `link:.dsh-host/...` manifest and lockfile paths, never the local link or machine-specific paths.

For the coordinated reference packages, keep `dsh-annotation-core`, `dsh-obsidian-bridge` and `dsh-session-sticker-board` in sibling directories at their matching candidate versions. Build Core first, then Bridge, then Sticker. Their explicit sibling development links use those built packages without pulling older registry artifacts. Core's additional current-host integration checks run with `pnpm exec vitest run --config vitest.native-current.config.ts --maxWorkers=1`.

Release archives and verification logs stay local and are excluded from source commits.
