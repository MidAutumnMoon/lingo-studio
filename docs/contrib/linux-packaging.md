---
description: Linux packaging flow — build commands, upstream better-sqlite3 prebuilds, and the GLIBC 2.34 floor
sources:
  - scripts/before-pack.js
  - electron-builder.yml
---

# Linux Packaging

Linux builds use the upstream `better-sqlite3` prebuilts that ship inside the
npm package (`prebuilds/`). Since v13 the module is N-API, so one ABI-stable
binary serves both the test runner (system Node) and the app (Electron) —
nothing is compiled, downloaded, or pinned at build time anymore.

## Build

```bash
# Build both architectures
pnpm build:linux

# Build one architecture
pnpm build:linux:x64
pnpm build:linux:arm64
```

Cherry Studio packaging does not require Docker or QEMU.

## Packaging Flow

`beforePack` (`scripts/before-pack.js`) filters the package's `prebuilds/`
down to the target platform-arch file, alongside the other per-platform
prebuilt packages; electron-builder then packs the app with the surviving
upstream `better_sqlite3.node`. A missing prebuilt package for the target
stops packaging.

## Minimum glibc

The upstream linux prebuilds require **GLIBC 2.34** and **GLIBCXX 3.4.29**
(x64 and ARM64 alike). Distributions with an older glibc cannot load the
binary. Rolling-release Linux is the support target; macOS and Windows
packaging is best-effort.
