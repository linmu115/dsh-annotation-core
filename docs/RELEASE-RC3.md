# RC3 / Windows and macOS candidate

Version: `0.3.12-dsh021rc3.1`. Target: official `0.2.1-rc.3`, tag commit `1f81c047fc48fa190a683e469daa699857e9afe8`.

Retargets the host and browser API cohort to official DSH 0.2.1-rc.3. The same JavaScript package serves Windows and macOS; no platform-specific code is needed.

One source branch and one package are maintained for both operating systems. Build and regression checks run on Apple Silicon macOS. Windows-specific native checks are to be run on Windows; platform-independent Windows path, quoting and launch decisions are covered locally. UI operations in the user's live profile and Vault remain a separate acceptance step.

Build with Node 24, the repository package manager, and the exact RC3 host source. For the three Core/Bridge/Sticker packages, run `prepare:host` against the built official source before build/typecheck/test. Build in order: Core, Bridge, Sticker. The Obsidian companion vendors its protocol and Core package archives for reproducibility.

Installed Desktop reports RC3 with build commit `be72761ee1a6736ebcdf4f3739363b083ae53c98`; the public tag has the commit above. Source qualification uses that public tag. Stock and patched profile boot checks use fresh temporary homes and do not load user history or Vault bindings.
