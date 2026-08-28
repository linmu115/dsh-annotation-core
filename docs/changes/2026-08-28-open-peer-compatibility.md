# Annotation Core 0.1.3: version-open host peers

All host-provided peer dependencies now use `*`, and the fixed `dshWorkshop.compatibility.dshVersions` declaration has been removed. The plugin can therefore be installed with future DSH, Cordis, and React versions without a semver admission gate.

The development dependency graph remains pinned to the current verified DSH baseline. This keeps builds deterministic without converting that baseline into a runtime prohibition. Compatibility is decided by actual service and UI behavior.

Validation: typecheck, bundle build, tests, and package dry-run.
