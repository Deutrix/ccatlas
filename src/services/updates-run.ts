/**
 * The IO half of `updates`.
 *
 * `services/updates.ts` is pure so every classification can be tested against
 * constructed inputs. This composes it over the real collectors, the same way
 * `doctor-run.ts` does — and for the same reason: a detector that grew an
 * `fs` import would stop being testable against the cases that matter.
 */

import os from 'node:os';
import path from 'node:path';

import { createRegistryCollector } from '../collectors/registry.ts';
import { runCollector } from '../collectors/isolate.ts';
import { buildUpdatesReport } from './updates.ts';
import { status } from './status.ts';
import type { RegistryData } from '../collectors/registry.ts';
import type { UpdatesReport } from './updates.ts';
import type { StatusOptions } from './status.ts';

export interface UpdatesRunResult {
  readonly report: UpdatesReport;
  readonly degraded: string[];
}

export async function updates(options: StatusOptions = {}): Promise<UpdatesRunResult> {
  const home = options.roots?.home ?? os.homedir();

  // Built on `status`, not beside it. The merged inventory is where
  // `installedSha` and `doubleDeclared` already live, and a second path to
  // the same facts would drift from the one `status` reports.
  const { inventory } = await status(options);

  // A second registry pass, this one with clone probing on so the marketplace
  // manifests are read. `status` runs the collector too, but through a
  // context that may be in fixture mode; the entries are only obtainable from
  // real clones.
  const registry = await runCollector<RegistryData>(
    createRegistryCollector({ roots: { home }, probeClones: true }),
    { offline: options.offline ?? false },
  );

  const data = registry.status === 'ok' ? registry.data : undefined;

  return {
    report: buildUpdatesReport({
      inventory,
      entries: data?.entries ?? [],
      marketplaces: data?.marketplaces ?? [],
      now: Date.now(),
    }),
    degraded: inventory.degraded,
  };
}

/** Where the marketplace clones live, for diagnostics. */
export const marketplacesRoot = (home: string): string =>
  path.join(home, '.claude', 'plugins', 'marketplaces');
