#!/usr/bin/env node
/**
 * Bundles src/ into a single minified ESM file at bin/ccatlas.
 *
 * Plain JS on purpose: it stays out of the tsc typecheck graph and needs no
 * TypeScript loader to run.
 *
 * The output is extensionless. Node resolves an extensionless entry point's
 * module type from the nearest package.json `type` field, so `"type":
 * "module"` in package.json is what makes bin/ccatlas load as ESM. Do not
 * remove it.
 */

import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = path.join(repoRoot, 'src', 'index.ts');
const outFile = path.join(repoRoot, 'bin', 'ccatlas');

const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));

await mkdir(path.dirname(outFile), { recursive: true });

const result = await esbuild.build({
  entryPoints: [entryPoint],
  outfile: outFile,
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'node',
  // Keep in step with the engines floor in package.json.
  target: 'node22.13',
  // Zero runtime dependencies is load-bearing: anything that ends up external
  // would need a node_modules tree next to the plugin cache copy.
  packages: 'bundle',
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __CCATLAS_VERSION__: JSON.stringify(pkg.version),
  },
  metafile: true,
});

// Windows has no execute bit; chmod there is meaningless (and npm rewrites bin
// permissions on install anyway).
if (process.platform !== 'win32') {
  await chmod(outFile, 0o755);
}

const [outputPath, output] = Object.entries(result.metafile.outputs)[0];
process.stdout.write(
  `built ${path.relative(repoRoot, outputPath)} — ${output.bytes} bytes, ` +
    `${Object.keys(result.metafile.inputs).length} input module(s)\n`,
);
