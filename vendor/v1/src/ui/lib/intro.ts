/**
 * What to show at launch: first-run onboarding (empty library, never onboarded) or the "What's New"
 * sheet (a new build with a release not seen yet). The decision is pure (unit-tested); flags live in
 * localStorage, behind a probe so a blocked or missing storage never throws.
 */

export const INTRO_KEYS = {
  onboarded: 'tachinovel.intro.onboarded',
  build: 'tachinovel.whatsNew.build',
  seen: 'tachinovel.whatsNew.seen',
} as const;

export type IntroKey = keyof typeof INTRO_KEYS;

export interface IntroInput {
  libraryEmpty: boolean;
  /** Flags survive a relaunch. Without that nothing is shown: "once" couldn't be kept. */
  persistent: boolean;
  onboarded: boolean;
  lastBuild: string | null;
  seenRelease: string | null;
  build: string;
  latestRelease: string | null;
}

export interface IntroDecision {
  show: 'onboarding' | 'whatsNew' | null;
  /** Bookkeeping to store right away. Dismissing writes the rest (onboarded, or build + seen). */
  write: Partial<Record<IntroKey, string>>;
}

export function decideIntro(i: IntroInput): IntroDecision {
  if (!i.persistent) return { show: null, write: {} };
  if (!i.onboarded && i.libraryEmpty) {
    // New here: onboarding, and this build's news counts as seen (it all is new to them).
    return { show: 'onboarding', write: { build: i.build, ...(i.latestRelease ? { seen: i.latestRelease } : {}) } };
  }
  // Someone with a library is past onboarding, even if they never saw it.
  const write: Partial<Record<IntroKey, string>> = i.onboarded ? {} : { onboarded: '1' };
  if (i.lastBuild === i.build) return { show: null, write };
  if (i.latestRelease !== null && i.seenRelease !== i.latestRelease) return { show: 'whatsNew', write };
  return { show: null, write: { ...write, build: i.build } };
}

export interface FlagStore {
  readonly persistent: boolean;
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** localStorage when it works (probed), else an in-memory map that reports `persistent: false`. */
export function openFlagStore(storage: () => Storage = () => window.localStorage): FlagStore {
  try {
    const ls = storage();
    const probe = 'tachinovel.intro.probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return {
      persistent: true,
      get: (k) => {
        try {
          return ls.getItem(k);
        } catch {
          return null;
        }
      },
      set: (k, v) => {
        try {
          ls.setItem(k, v);
        } catch {
          // Full or blocked: the worst case is seeing the intro again.
        }
      },
    };
  } catch {
    const mem = new Map<string, string>();
    return { persistent: false, get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) };
  }
}

declare module '../dev/flags.ts' {
  interface DevFlags {
    /** Show onboarding / What's New under the dev flags too (off by default so tests and the dev server start clean). */
    intro?: boolean;
  }
}
