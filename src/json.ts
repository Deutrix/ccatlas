/**
 * The one `--json` envelope factory — T1.22.
 *
 * There used to be two. `src/envelope.ts` (scaffold, T0.8) declared
 * `SCHEMA_VERSION = 1` with `warnings: readonly string[]`; `src/types.ts`
 * declared `SCHEMA_VERSION = 1 as const` with structured `Warning[]`. Two
 * declarations of one concept, with incompatible warning types, and both
 * typechecked — so the drift was silent. Retiring the scaffold one is defect
 * D1 in `docs/tasks.md`, and it had to happen before the services layer was
 * written rather than after: services are the first code that produces
 * warnings at scale, and authoring them against `readonly string[]` would have
 * thrown away the codes the collectors already emit.
 *
 * The envelope is a contract with skills, not with humans. `T7.3`–`T7.5` read
 * this shape; a field renamed here is a skill broken there.
 */

import { SCHEMA_VERSION } from './types.ts';
import type { JsonEnvelope, Warning } from './types.ts';

export { SCHEMA_VERSION };
export type { JsonEnvelope, Warning };

/**
 * Builds the envelope. `generatedAt` is stamped here, once, so that every
 * surface reports the time the answer was produced rather than the time it was
 * serialised — they differ by the whole render for the HTML report.
 */
export function envelope<T>(
  command: string,
  version: string,
  data: T,
  warnings: readonly Warning[] = [],
): JsonEnvelope<T> {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'ccatlas',
    version,
    command,
    generatedAt: new Date().toISOString(),
    warnings: [...warnings],
    data,
  };
}
