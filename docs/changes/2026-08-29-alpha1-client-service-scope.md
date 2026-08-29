# 0.3.2 — alpha.1 client service visibility

- Mount the Client Remote contribution directly from the plugin's declared injection context.
- Publish `annotationCore` on the top-level Client plugin context so separately loaded consumers such as Sidechat and Sticker Board can inject it.
- Keep the global annotation window and native conversation integration owned by the same disposable plugin scope.
- Validate the deployed runtime against DSH `0.1.2-alpha.1`; keep runtime peers at `*` and development packages on an open lower-bound range because the alpha.1 package set is not yet published to npm.
