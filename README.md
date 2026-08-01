# ccatlas

**Know what's in your Claude Code stack, what it costs you, and what you never use.**

[![npm](https://img.shields.io/npm/v/ccatlas)](https://www.npmjs.com/package/ccatlas)
[![license](https://img.shields.io/npm/l/ccatlas)](./LICENSE)
[![node](https://img.shields.io/node/v/ccatlas)](https://nodejs.org)

You installed a dozen plugins over a few months. Which are still current? Which
load into every single turn whether you use them or not? Which have you not
touched since the day you installed them?

ccatlas answers that in one command.

```sh
npx ccatlas@latest status
```

```
ccatlas status — global · collected in 2.1s

  Marketplaces    4  ok
  Plugins         5  ok
  Skills        138  ok
  Agents         47  ok
  Commands      208  ok
  MCP servers    10  ok
```

---

## What it does

**Finds updates your plugin manager can't see.** Claude Code resolves a version
from the first of four rules, and which one fired changes what "update" means.
When the version came from a string but the source has moved on, `/plugin
update` reports *"already at the latest version"* — and you keep running old
code. ccatlas records which rule fired, so it catches this. No other tool does.

**Shows what each extension costs you in context.** Not money — *context*.
Roughly how many tokens something occupies in every turn whether you invoke it
or not. A skill you use twice a month may be quietly taxing every prompt.

**Tells you what you actually use.** Reads your own transcripts and counts real
invocations, then lists what has never been invoked once — sorted by what it
costs to keep.

**Moves your setup to another machine.** One bundle, one import, credentials
never included.

---

## Install

**As a Claude Code plugin** — adds `/stack`, `/stack-doctor`, `/stack-updates`,
`/stack-usage` and `/stack-report`:

```
/plugin marketplace add https://github.com/Deutrix/claude-plugins.git
/plugin install ccatlas@deutrix
```

**As a CLI:**

```sh
npm i -g ccatlas
# or, without installing
npx ccatlas@latest status
```

Needs Node 22.13+ or 24+. **Zero dependencies** — nothing else is installed.

---

## Commands

| | |
|---|---|
| `ccatlas status` | what is installed, from where, and whether the sources agree |
| `ccatlas doctor` | problems, each with a cause and the exact command that fixes it |
| `ccatlas updates` | version drift, stale pins, marketplaces gone quiet |
| `ccatlas usage` | what you invoke, and what you never do |
| `ccatlas report` | a self-contained HTML report you can send to someone |
| `ccatlas export` | a portable bundle of your whole setup |
| `ccatlas import` | preview an import, then apply it |
| `ccatlas rollback` | undo the last change |

Handy: `--json` on everything, `--offline` for guaranteed zero egress,
`--check` to exit non-zero in CI when something needs attention.

---

## What you'll probably find

Run `ccatlas usage --unused` and expect a surprise. On the machine this was
built against, **385 of 439 installed skills, agents and commands had never been
invoked once** — 88% of them — across 335 transcripts and 1,439 real
invocations. They load anyway, every turn.

That is the number this tool exists to put in front of you.

`ccatlas doctor` finds the rest: plugins pinned to a moved source, cached
versions nothing refers to, projects recorded in your config that no longer
exist, MCP servers defined twice at different scopes.

---

## Your data stays yours

- **Zero telemetry.** Nothing is sent anywhere, ever. `--offline` makes that a
  guarantee, and there is a test asserting it.
- **Read-only by default.** Every change goes through Claude Code's own CLI, and
  nothing is modified without showing you the exact plan first.
- **Exports refuse to leak.** A credential that can't be safely replaced with a
  `${VAR}` placeholder stops the export rather than shipping in it. Never
  included: credentials, session history, caches, todos.
- **Reports can be redacted.** `--redact` strips paths, repo names and your
  hostname before you send one to anyone.

---

## Contributing

```sh
npm install && npm test
```

Requires Node 22.13+. `npm run build` bundles to a single file at `bin/ccatlas`.

Issues and pull requests: [github.com/Deutrix/ccatlas](https://github.com/Deutrix/ccatlas).

## License

MIT © [Deutrix](https://github.com/Deutrix)
