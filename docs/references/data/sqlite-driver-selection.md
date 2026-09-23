---
description: Proposal and verification plan for replacing better-sqlite3 with the runtime-provided node:sqlite driver, including the dev-time ABI pain it would remove
sources:
  - src/main/data/db/DbService.ts
  - src/main/data/db/applyMigrations.ts
  - src/main/data/db/sqliteErrors.ts
  - src/main/data/db/restore
  - src/main/data/migration/v2
  - src/main/features/knowledge/pipeline/vectorstore/indexStore
  - tests/helpers/db
  - scripts/invalidate-electron-rebuild-metadata.js
  - package.json
---

# SQLite Driver Selection

**Status: proposal, not implemented.** Nothing in this document describes current behaviour beyond the
"today" sections, which are facts about the shipped code. The implemented data-layer contract lives in
[database-patterns.md](./database-patterns.md) and [database-construction.md](./database-construction.md).

## Why this document exists

The application and its `main`-project tests load **one** compiled native addon, but they run in **two
different runtimes**: Electron's main process (the app) and plain Node (Vitest). Those runtimes have
incompatible V8 ABIs, so the addon has to be rebuilt for whichever side runs next. In practice that
means a forced `electron-rebuild` before every app start and a `pnpm rebuild` before every full test
run, and a wrong pairing fails as a raw linker error rather than a readable one.

A migration would delete that whole class of problem rather than managing it: the platform now ships a
synchronous SQLite driver — `node:sqlite` — that covers every capability this codebase uses.

## How the driver is wired today

| Piece | Where |
|---|---|
| The single connection, pragmas, `withWriteTx` | `src/main/data/db/DbService.ts` |
| Migrations (Drizzle journal) | `src/main/data/db/applyMigrations.ts`, `migrations/sqlite-drizzle/` |
| ORM | `drizzle-orm/better-sqlite3` (drizzle-orm `^0.44.5`) |
| Error classification (busy, constraint, trash) | `src/main/data/db/sqliteErrors.ts` |
| Backup / checkpoint / restore | `src/main/data/db/restore/` |
| Vector index (own connection + driver port) | `src/main/features/knowledge/pipeline/vectorstore/indexStore/` |
| Real-DB test harness | `tests/helpers/db/`, used by 169 test files |
| ABI flip scripts | `package.json` (`rebuild:electron`, `rebuild:node`, `pretest`, `pretest:main`, `dev`, `debug`, `start`) and `scripts/invalidate-electron-rebuild-metadata.js` |

Three properties of the layer make the driver choice load-bearing:

1. **Synchronous by contract.** Queries run inline and `withWriteTx(fn)` takes a synchronous callback, so
   a read-then-write cannot interleave. This is written down in
   [database-patterns.md](./database-patterns.md) and every caller depends on it.
2. **FTS5** — full-text search tables and triggers (see `migrations/sqlite-drizzle/0016_*.sql`).
3. **Loadable SQLite extensions** — the knowledge vector index loads `sqlite-vec` into its own
   connection (`db.loadExtension(toAsarUnpackedPath(getLoadablePath()))`) to get `vec0` tables.

## Pain points of the current approach

**P1 — better-sqlite3 is V8-direct, not Node-API, so no single artifact can serve both runtimes.**
It is compiled against one runtime's V8 headers (`binding.gyp` builds `src/better_sqlite3.cpp`; the addon
loads through `require('bindings')('better_sqlite3.node')`, a fixed path list with no runtime awareness).
A Node-API addon could satisfy both runtimes; this one cannot, by design.

**P2 — The ABI flip is forced on every start, and only one side can be a download.**
`debug` / `dev` / `dev:watch` / `start` run `electron-rebuild --force` first; `pretest` / `pretest:main`
run `rebuild:node`. The Node side resolves through `prebuild-install`, which is a cached download
(`~/.npm/_prebuilds/…-node-v137-…`), while `electron-rebuild` compiles from source through node-gyp — so
the Electron side always costs a toolchain (gcc, make, python3) and minutes.
`scripts/invalidate-electron-rebuild-metadata.js` exists only to defeat pnpm's "already built" caching
across a flip.

**P3 — A wrong pairing fails as a linker error, not as a diagnosis.**
Loading an Electron-ABI build under Node 24 surfaces as
`undefined symbol: _ZN2v811HandleScope6ExtendEPNS_7IsolateE`, because Electron patches V8: the addon's
C++ symbols do not exist in Node's V8, and the failure arrives from the dynamic loader instead of as a
version message. Nothing in it names the pairing, so the failure reads as broken code. Observed
consequence in practice: a large batch of unrelated suites failing at once, and an afternoon spent on a
missing native build rather than a bug.

**P4 — The deeper cause is a test/runtime mismatch, not the driver alone.**
The production DB layer is exercised under a different runtime than it ships in. That is a deliberate
policy — the harness forbids stubbing the database, and 169 test files open a real, migrated database —
so the Node side genuinely needs a working native driver. Any fix that keeps that harness unchanged
keeps the flip; only moving those tests into Electron or changing the driver removes it.

**P5 — Native-artifact surface, per platform and per upgrade.**
Every target platform/arch needs its own compiled addon, rebuilt for the app's Electron by
electron-builder, and unpacked from asar (the extension needs explicit handling — see
`toAsarUnpackedPath`). Bumping Electron or Node re-opens the compile path, and the data layer's SQLite
version is tied to better-sqlite3's release cadence rather than the runtime's.

**P6 — The decision has not been stable historically.**
`better-sqlite3` entered in 2024-09, was replaced by sequelize at one point, then returned; the
app-data SQLite layer itself dates to 2025-05 and the real-DB test harness to 2026-04. Three
re-platforms in about two years is a reason to write the next move down before making it.

## Candidate: `node:sqlite`

Runtime-provided, synchronous (`DatabaseSync`, `StatementSync`), no compilation and no ABI coupling —
the same code path in Electron's main process and in Node.

Verified in this checkout (Node 24.20; Electron 44, pinned as 44.2.0):

| Check | Result |
|---|---|
| FTS5 virtual table + `MATCH` query | works |
| `sqlite-vec` extension load + `vec0` table | works, with `new DatabaseSync(path, { allowExtension: true })` |
| Present in Electron's Node (main process) | yes (`node:sqlite`, `DatabaseSync` symbols in the binary) |
| Stability warning in Node 24.20 | none |

## What to verify before switching

**A. Runtime availability and support matrix.** Confirm `node:sqlite` is present and enabled in every
Electron major the project supports, in the Node version CI uses, and in the utility process if it ever
touches the database. Decide the minimum Electron version this pins the project to.

**B. Capability parity, item by item.** FTS5 (and the exact tokenizers/options in use), loadable
extensions, the pragmas the restore path depends on (`wal_checkpoint(TRUNCATE)`,
`integrity_check` with a simple result), the backup API used by `src/main/data/db/restore/`, and value
binding rules (blobs: today `Uint8Array` is wrapped in `Buffer` by hand — check whether that shim can go).
`serialize`, user-defined functions and aggregates are unused today; verify that stays true.

**C. SQLite version and build differences.** better-sqlite3 bundles its own SQLite; `node:sqlite` bundles
the runtime's. Compare versions, compile options, collations, limits and FTS5 tokenizer behaviour, then
decide which differences are acceptable. Existing FTS5 indexes are written by the old build and read by
the new one — a rebuild path may be needed (there is precedent: `ftsRebuild`).

**D. The Drizzle adapter path.** drizzle-orm `0.44.5` ships no `node-sqlite` adapter (it has
better-sqlite3, bun-sqlite, expo-sqlite, op-sqlite, sqlite-proxy, …). Determine whether a newer version
adds one, whether `sqlite-proxy` can be driven synchronously, or whether a small adapter behind the
existing port is the honest answer. This is the main unknown and the largest piece of work.

**E. The synchronous contract end to end.** Prove that `DatabaseSync`/`StatementSync` preserve
`withWriteTx`'s `BEGIN IMMEDIATE` semantics, busy handling and `journal_mode=WAL` behaviour, and that no
caller needs to become async.

**F. Error taxonomy.** `sqliteErrors.ts` and the trash/`SQLITE_BUSY` classifications read better-sqlite3
error shapes; re-verify them against `node:sqlite` error objects on real failures, not on guesses.

**G. Migration, seeding and restore machinery.** Enumerate the call sites in `applyMigrations`,
`src/main/data/migration/v2/`, the seeders, and `src/main/data/db/restore/`, and write down the list of
behaviours that must be re-tested (fresh install, upgrade from a populated v2 database, snapshot,
restore, integrity check).

**H. Test harness and tooling.** `tests/helpers/db/`, `tests/__mocks__/main/DbService.ts` and the
`withWriteTx` integration test are the contract here. On success, `rebuild:electron`, `rebuild:node`,
`pretest`/`pretest:main` and `scripts/invalidate-electron-rebuild-metadata.js` all disappear — that
deletion is the acceptance test for the whole project.

**I. Performance, measured before committing.** better-sqlite3 is the performance baseline: benchmark
bulk message insert, FTS search, `vec0` search and startup migration on a large database, and write down
the acceptable regression before starting, not after.

**J. Packaging and release.** Remove the native-rebuild step and confirm asar/`asarUnpack` handling for
the addon is gone, while `sqlite-vec` still resolves after packaging. Re-check CI for build jobs that
exist only to compile natives.

**K. Reversibility.** Keep the driver behind `DbService` (and behind the existing `SqliteDriver` port in
the vector index) so a revert is a dependency-plus-adapter change, and take a database snapshot before
the first cutover on real user data.

## Expected net gain

Disappears:

- The ABI flip and its failure mode (P1–P3), including the toolchain dependency for the data path.
- Four package scripts and the metadata-invalidation workaround, plus the CI time they cost.
- A compiled artifact per platform/arch to build, unpack and ship; Electron bumps stop re-opening a
  compile path.
- SQLite updates arrive with the runtime instead of on better-sqlite3's cadence.

Stays or grows:

- `sqlite-vec` remains a loadable extension (it is a SQLite extension, not a Node addon, so it was never
  ABI-bound) and keeps its asar handling.
- The migration itself: a Drizzle adapter path, call-site changes in the restore path, error-mapping
  verification, and a performance check. That is a project, not a patch.
- New coupling to the runtime's SQLite version and to `node:sqlite`'s API stability, instead of to a
  third-party addon's release cadence.

Note the gain is only realised if **every** consumer moves, tests included. Moving only the app (or only
the tests) leaves the flip in place.

## Suggested sequencing

1. **Spike** (time-boxed): port the *knowledge vector index* to `node:sqlite` first. It already sits
   behind a `SqliteDriver` port with `BetterSqlite3Driver` as "the only engine", so it is the cheapest
   place to learn whether FTS5, `vec0`, pragmas and error handling behave, without touching app data.
2. **Adapter decision**: resolve D (Drizzle) with the spike's findings in hand.
3. **Parallel-run the app data layer**: implement the `node:sqlite` adapter behind `DbService`, keep
   better-sqlite3 installed, and run the full test suite against both.
4. **Cut over behind a snapshot**, then delete `better-sqlite3` and the flip scripts in the same change
   that removes the last import.

## If the migration is deferred

The daily pain has a much cheaper mitigation, and it is worth doing regardless:

- Build each ABI **once** into `build/node/` and `build/electron/` and make the active
  `build/Release/better_sqlite3.node` a copy of the chosen one, so switching is a file copy instead of a
  compile; only an Electron/Node bump needs a rebuild.
- Add a guard to `pretest` (and to the app scripts) that loads the active binding in the target runtime
  and fails with one sentence naming the pairing and the fix — so a wrong ABI can never again surface as
  a hundred unrelated test failures.

## Open questions

- Is upstream already moving this way? A driver change of this size is worth aligning before diverging.
- What is the minimum Electron version the project is willing to require, given `node:sqlite`'s
  availability and stability per major?
- How large is the real-world performance delta on the hot paths (message writes, full-text search,
  vector search), and what regression would be acceptable to delete an entire build-time problem class?

## Appendix: reproducing the diagnosis

```bash
# What the addon is built for (electron-rebuild stamps the target ABI here):
cat node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/.forge-meta
# What Node needs:
node -p "process.versions.modules"
# Does the active binding satisfy Node?
node -e "require('better-sqlite3')"   # undefined symbol / missing bindings ⇒ the flip is on the wrong side
```
