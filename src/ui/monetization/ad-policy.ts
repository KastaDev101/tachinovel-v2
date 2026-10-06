/**
 * Ad pacing policy (pure, unit-tested). Decides WHEN an interstitial may show; never shows one itself.
 *
 * Rules (docs/monetization.md "Placement design"):
 *  1. Pro users (subscription or lifetime) never see ads. Rewarded ads are also hidden for them.
 *  2. Never while reading or listening: no interstitial if a chapter was opened/saved in the last
 *     `readingQuietMs`, or while narration is playing/paused.
 *  3. Only at a browse → novel transition (the user opened a novel from Browse/Search/Global search
 *     after browsing for a while), never on launch, never on back navigation, never from the library.
 *  4. Frequency caps: min gap between interstitials, max per day, at most one per N novel opens.
 *  5. Grace: no interstitials in the first session after install.
 * Rewarded ads are user-initiated only (e.g. "+60 min of HD voice"), capped per day.
 */

export interface AdPolicyConfig {
  minGapMs: number;
  maxPerDay: number;
  /** Show at most one interstitial per this many browse→novel opens. */
  opensPerAd: number;
  /** Browse/search calls needed in the current browse burst before an open can trigger an ad. */
  minBrowseCalls: number;
  /** A browse burst ends after this much inactivity in browse. */
  browseBurstMs: number;
  /** No interstitial within this long after any chapter.get / progress.save. */
  readingQuietMs: number;
  maxRewardedPerDay: number;
}

export const DEFAULT_AD_POLICY: AdPolicyConfig = {
  minGapMs: 12 * 60_000,
  maxPerDay: 4,
  opensPerAd: 3,
  minBrowseCalls: 3,
  browseBurstMs: 5 * 60_000,
  readingQuietMs: 3 * 60_000,
  maxRewardedPerDay: 3,
};

export interface AdPolicyState {
  /** Epoch ms of shown interstitials (last 24 h). */
  shown: number[];
  rewarded: number[];
  opensSinceAd: number;
  sessions: number;
}

export function emptyAdState(): AdPolicyState {
  return { shown: [], rewarded: [], opensSinceAd: 0, sessions: 0 };
}

const DAY = 24 * 60 * 60_000;
const BROWSE_METHODS = new Set(['browse.list', 'browse.search', 'browse.globalSearch']);
const READING_METHODS = new Set(['chapter.get', 'progress.save']);

export class AdPolicy {
  private browseCalls = 0;
  private lastBrowseAt = 0;
  private lastReadingAt = 0;
  private readonly cfg: AdPolicyConfig;
  private state: AdPolicyState;
  private readonly env: { now(): number; isPro(): boolean; isNarrating(): boolean };

  constructor(cfg: AdPolicyConfig, state: AdPolicyState, env: { now(): number; isPro(): boolean; isNarrating(): boolean }) {
    this.cfg = cfg;
    this.state = state;
    this.env = env;
  }

  /** Call once per app launch. */
  startSession(): void {
    this.state.sessions++;
  }

  snapshot(): AdPolicyState {
    return { ...this.state, shown: [...this.state.shown], rewarded: [...this.state.rewarded] };
  }

  /**
   * Feed every bridge call (observed, not intercepted). Returns true when THIS call is a moment where
   * an interstitial may be shown (the caller then shows a preloaded ad, and calls recordShown()).
   */
  onCall(method: string): boolean {
    const now = this.env.now();
    if (READING_METHODS.has(method)) {
      this.lastReadingAt = now;
      return false;
    }
    if (BROWSE_METHODS.has(method)) {
      if (now - this.lastBrowseAt > this.cfg.browseBurstMs) this.browseCalls = 0;
      this.browseCalls++;
      this.lastBrowseAt = now;
      return false;
    }
    if (method !== 'novel.get') return false;
    const fromBrowse = this.browseCalls >= this.cfg.minBrowseCalls && now - this.lastBrowseAt <= this.cfg.browseBurstMs;
    if (!fromBrowse) return false;
    this.state.opensSinceAd++;
    return this.interstitialAllowed(now);
  }

  interstitialAllowed(now = this.env.now()): boolean {
    if (this.env.isPro() || this.env.isNarrating()) return false;
    if (this.state.sessions <= 1) return false;
    if (now - this.lastReadingAt < this.cfg.readingQuietMs) return false;
    if (this.state.opensSinceAd < this.cfg.opensPerAd) return false;
    this.state.shown = this.state.shown.filter((t) => now - t < DAY);
    if (this.state.shown.length >= this.cfg.maxPerDay) return false;
    const last = this.state.shown[this.state.shown.length - 1];
    if (last !== undefined && now - last < this.cfg.minGapMs) return false;
    return true;
  }

  recordShown(now = this.env.now()): void {
    this.state.shown.push(now);
    this.state.opensSinceAd = 0;
  }

  rewardedAvailable(now = this.env.now()): boolean {
    if (this.env.isPro()) return false;
    this.state.rewarded = this.state.rewarded.filter((t) => now - t < DAY);
    return this.state.rewarded.length < this.cfg.maxRewardedPerDay;
  }

  recordRewarded(now = this.env.now()): void {
    this.state.rewarded.push(now);
  }
}
