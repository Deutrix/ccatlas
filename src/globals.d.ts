/**
 * Injected by esbuild at build time (see scripts/build.mjs).
 *
 * The version is inlined rather than read from a sibling package.json at
 * runtime: the shipped artifact is a single file that gets copied into
 * `~/.claude/plugins/cache`, where no sibling package.json is guaranteed.
 */
declare const __CCATLAS_VERSION__: string;
