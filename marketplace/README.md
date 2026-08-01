# deutrix — Claude Code marketplace

```bash
claude plugin marketplace add deutrix/claude-plugins
claude plugin install ccatlas@deutrix
```

## Why entries here carry no `version`

🧠 **T7.14, decided deliberately.** Claude Code resolves a plugin's version
from `plugin.json` first and the marketplace entry second — and when both are
set, **`plugin.json` wins silently**. A version here would therefore be masked
the moment the two diverge, and nothing would report the divergence.

We observed exactly that on a real plugin: `ui-ux-pro-max` declares `2.5.0` in
`plugin.json` and `2.2.1` in its marketplace entry, from the same repository.
Anyone reading the catalogue sees `2.2.1`; what installs is `2.5.0`.

So the version lives in `plugin.json` only. `scripts/package.mjs` fails the
build if an entry here declares one.

## `source: npm`

The plugin ships from one artefact, published to npm as `ccatlas`. That keeps
the marketplace entry a pointer rather than a second copy of the release.
