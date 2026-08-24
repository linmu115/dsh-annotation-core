# dsh-annotation-core

Shared Codex-style annotation bubbles, reliable submission, and durable annotation details for DSH plugins.

English · [中文](README.md)

## Compatibility

- Official DeepSeek Harness `0.1.1-rc.2`
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
- Sent user messages show an “`N annotations`” pill that reopens immutable details.
- “Annotation N” links in model answers open the corresponding item.
- A failed submission keeps the text, images, and annotations in place.

## Troubleshooting

### Nothing appeared after installation

This is expected for the core alone. Install `dsh-sidechat` or `dsh-session-sticker-board` as well.

### Can both consumers be installed?

Yes. Both use the same single core instance.

### Can this be used with another DSH version?

This release is validated only against official `0.1.1-rc.2`. Before upgrading DSH, create a rollback point in Maintenance Engine and run its compatibility checks.

## License

MIT
