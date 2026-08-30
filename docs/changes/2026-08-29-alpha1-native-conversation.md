# 0.2.0 - DSH 0.1.2-alpha.1 native Conversation migration

- Replaced the removed `dsh-client-runtime` surface with `api-session-controller`, `ui-conversation`, and `ui-chat` contracts.
- Registers annotation nodes through `ctx.uiConversation.events` and the alpha Chat node data registry.
- Removed the RC2 adapter/probe layer. This release intentionally targets the new DSH interface directly.
- Alpha-only client services are declared through `dsh.client.inject`, not npm peers; compatibility is decided by exercised interfaces, not a package-version gate.

Verification: typecheck, unit tests, browser bundle contract, package dry run, and live alpha profile loading.
