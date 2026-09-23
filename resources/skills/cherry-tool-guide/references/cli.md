# Shell runtimes and command-line tools

Covers running local, project-scoped, or one-off work with `bun`, `uv` / `uvx`, and
`rg`, plus what to do when a command-line tool you need is missing. Cherry Studio
bundles no runtimes and manages no CLI environment: these are ordinary programs on
the session's shell PATH, and installing software is always the user's call, never
yours.

## Choose by lifetime

Use the shortest-lived mechanism that fits:

| Need | Use |
| --- | --- |
| Run a JS/TS file | `bun <file>` |
| Install an existing JS project's dependencies / add a project dependency | `bun install` / `bun add <pkg>` in the project cwd |
| Run a one-off JavaScript package | `bun x <tool>` |
| Run a Python file | `uv run python <file>` |
| Run Python with a temporary dependency | `uv run --with <pkg> python <file>` |
| Run a one-off Python CLI | `uvx <tool>` |
| Search local files or contents | `rg` |

## They are system PATH tools

`bun`, `uv` / `uvx`, and `rg` are whatever the user's shell provides — Cherry neither
bundles nor versions them. Check with `command -v <name>` before relying on one, and
do not assume a version or install location. Where present, prefer them over `node` /
`npm` / `npx` / `pip`, which are not guaranteed to exist either. The guidance in this
reference applies only when the session exposes a shell.

## A tool is missing → tell the user, never install it

If `command -v` cannot resolve a tool you need, stop and tell the user what is
missing and how they can install it (their usual package manager, the tool's own
installer). Never run an installer yourself — no `npm install -g`, `brew install`,
`apt install`, `pipx install`, `cargo install`, `uv tool install`, or a manually
downloaded binary. The same applies to a missing language runtime: report it; do not
provision it.

## Keep changes project-scoped

Keep dependency changes inside the current project. Global installs (`-g` /
`--global`, `uv tool install`, `pip install --user`) leak state across agent sessions
and belong to the user, not to you. Use `bun x` / `uvx` for one-off tools.

## Recovery

- **`command -v` resolves the tool but the command fails** → read the error and
  correct the invocation; don't reinstall or "upgrade" anything on the user's behalf.
- **Tool missing** → report it and what you would have used it for; suggest the
  install command but let the user run it.

## Example

> "I need `jq` for a one-off data-processing task."

`command -v jq` — if it resolves, use it. If not, either use a one-off runner that
avoids it (e.g. `bun x` / `uvx` with an equivalent package) or tell the user to
install `jq` themselves. Never install it for them.
