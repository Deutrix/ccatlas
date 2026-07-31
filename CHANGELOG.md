# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **T0.8 — repo scaffold.** TypeScript source bundled by esbuild to a single
  minified ESM file at `bin/ccatlas`; `node:test` test runner; `tsc --noEmit`
  typecheck; 3-platform × 2-Node-version GitHub Actions matrix. Zero runtime
  dependencies — `package.json` declares no `dependencies` block, and a test
  asserts the bundle imports nothing outside `node:*`.
  - Node floor set to `^22.13.0 || >=24.0.0`, the range in which `node:sqlite`
    is available without a flag (required by T4.2).
  - `ccatlas --version` and `ccatlas --json` implemented as toolchain proof
    only. The `--json` envelope carries `schemaVersion: 1`; its field set is
    **not** the frozen schema — see T0.7 and T1.20/T1.22.
  - CI steps for `claude plugin validate . --strict` and
    `claude plugin details ccatlas` are wired but **non-blocking**: there is no
    `plugin.json` yet (T7.1) and nothing published to measure (T7.6). The
    600-always-on-token ceiling is named as a constant but not yet enforced,
    because the output grammar of `plugin details` is still under discovery
    (T0.2).

[Unreleased]: https://github.com/deutrix/ccatlas/compare/HEAD...HEAD
