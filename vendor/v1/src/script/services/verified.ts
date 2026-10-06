/**
 * Plugin verification results (plugins/verified.json, produced by `tools/plugin-survey.ts --verify` on the
 * PC). Bundled as JSON via a named import of `plugins` (the top-level metadata is tree-shaken); reduced to
 * id → {version, status} on first use. A result only applies to the exact version that was verified.
 */
import { plugins } from '../../../plugins/verified.json';
import type { SourceFailureReason } from '../../shared/contracts/domain.ts';
import { errorReason } from '../lib/errors.ts';

export type VerifiedStatus = 'works' | 'partial' | 'broken';

const STATUSES: ReadonlySet<string> = new Set<VerifiedStatus>(['works', 'partial', 'broken']);

interface Verified {
  version: string;
  status: VerifiedStatus;
  reason?: SourceFailureReason;
}

let table: Map<string, Verified> | null = null;

function load(): Map<string, Verified> {
  const out = new Map<string, Verified>();
  for (const [id, v] of Object.entries(plugins as Record<string, { version?: unknown; status?: unknown; reason?: unknown }>)) {
    if (typeof v.version === 'string' && typeof v.status === 'string' && STATUSES.has(v.status)) {
      const entry: Verified = { version: v.version, status: v.status as VerifiedStatus };
      const reason = errorReason({ reason: v.reason }); // only known reasons
      if (reason) entry.reason = reason;
      out.set(id, entry);
    }
  }
  return out;
}

/** Why this exact plugin version doesn't fully work (verified.json `reason`), if recorded. */
export function verifiedReason(id: string, version: string): SourceFailureReason | undefined {
  table ??= load();
  const v = table.get(id);
  return v && v.version === version ? v.reason : undefined;
}

/** Verification status of this exact plugin version, or undefined if that version wasn't verified. */
export function verifiedStatus(id: string, version: string): VerifiedStatus | undefined {
  table ??= load();
  const v = table.get(id);
  return v && v.version === version ? v.status : undefined;
}

const RANK: Record<VerifiedStatus | 'unknown', number> = { works: 0, partial: 1, unknown: 2, broken: 3 };

/** Sort key: works, partial, unknown, broken. */
export function verifiedRank(status: VerifiedStatus | undefined): number {
  return RANK[status ?? 'unknown'];
}
