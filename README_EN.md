# dsh-annotation-core

Shared Codex-style annotation bubbles, reliable submission, and durable annotation details for DSH plugins.

`0.3.10-dev.2` uses the public APIs of official DSH RC1, with native input settlement and optional plugin-owned acceptance receipts. Admission failures retain drafts; late backlinks cannot restore deleted relations. No patched host is required.

When the host tools service is available, `dsh_reference_list` and `dsh_reference_read` expose submitted references in the current conversation and its current execution batch. Snapshot reads retain original content; refresh uses the existing source adapter without rewriting submitted input. Forked references expose inherited snapshots without creating backlinks. The optional Runtime Support plugin bridges these tools into selected Codex executions. Neither arbitrary note paths nor model-driven deletion are exposed.

English · [中文](README.md)

## Compatibility

- DeepSeek Harness (official `0.1.2-alpha.1` is the current client baseline, not an installation constraint)
- Official `web` profile
- No EAC or desktop-shell dependency

This is a foundation plugin. It intentionally has no separate sidebar page or dashboard. Install a consumer plugin before expecting a visible UI.

## Installation

Install in this order:

1. Install the core:

   ```bash
   dsh plugin --profile web add dsh-annotation-core
   ```

2. Install either or both consumer plugins:

   - `dsh-sidechat` for quoting DSH messages into the main or side conversation.
   - `dsh-session-sticker-board` for stickers, Obsidian note references, and bidirectional links.

3. Fully restart `dsh web`, then refresh the browser.

When sidechat or sticker-board is installed through DSH Maintenance Engine, the engine checks and installs the matching core version automatically.

## Usage

After a consumer adds a reference:

- References appear as annotation bubbles above the composer; no `@` token, quote block, or internal markup is inserted into the visible draft.
- Open a bubble to inspect the full selection, edit the optional comment, or remove the reference.
- Unsent annotations are renumbered after deletion.
- Deleting a pending Obsidian reference removes the DSH bubble immediately and retries source cleanup in the background without blocking note editing.
- Sent user messages show an “`N annotations`” pill that reopens immutable details.
- “Annotation N” links in model answers open the corresponding item.
- A failed submission keeps the text, images, and annotations in place.

## Troubleshooting

### Nothing appeared after installation

This is expected for the core alone. Install `dsh-sidechat` or `dsh-session-sticker-board` as well.

### Can both consumers be installed?

Yes. Both use the same single core instance.

### Can this be used with another DSH version?

Current client evidence comes from official `0.1.2-alpha.1`, but package metadata does not reject other DSH versions. Judge compatibility through runtime interfaces and regression tests, with a Maintenance Engine rollback point before upgrades.

## License

MIT
