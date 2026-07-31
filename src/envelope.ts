/**
 * The versioned `--json` envelope every ccatlas command emits.
 *
 * Scaffold-stage only: the field set here is deliberately minimal and is NOT
 * the frozen schema. The real schema is decided in T0.7 (bundle schema v1) and
 * the surface contracts in T1.20/T1.22. `schemaVersion` exists from day one so
 * that consumers never have to guess whether they are looking at a versioned
 * payload.
 */

export const SCHEMA_VERSION = 1;

export interface Envelope<T> {
  readonly schemaVersion: number;
  readonly tool: 'ccatlas';
  readonly version: string;
  readonly command: string;
  readonly generatedAt: string;
  readonly warnings: readonly string[];
  readonly data: T;
}

export function envelope<T>(
  command: string,
  version: string,
  data: T,
  warnings: readonly string[] = [],
): Envelope<T> {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'ccatlas',
    version,
    command,
    generatedAt: new Date().toISOString(),
    warnings,
    data,
  };
}
