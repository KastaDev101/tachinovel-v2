/**
 * Free vs Pro feature split + the StoreKit 2 plugin API (ios/App/App/Native/Store/StorePlugin.swift).
 *
 * Pro = ad-free + extras; unlocked by EITHER an auto-renewable subscription (monthly/annual) OR a
 * one-time lifetime non-consumable. Rationale per feature (annoyance vs pull vs review risk) lives in
 * docs/monetization.md "Free vs Pro". Hard rule from the App Store risk analysis: never charge for
 * access to third-party content (sources, chapters, number of sources): paywalls cover app features only.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type Tier = 'free' | 'pro';

export interface FeatureSpec {
  tier: Tier;
  /** Free-tier allowance, when the feature is metered rather than locked. */
  freeLimit?: number;
  note: string;
}

/** Product ids (App Store Connect). One subscription group "Pro" with monthly + annual; lifetime is a non-consumable. */
export const PRODUCTS = {
  monthly: 'pro.monthly',
  annual: 'pro.annual',
  lifetime: 'pro.lifetime',
} as const;

export const FEATURES = {
  reading: { tier: 'free', note: 'Library, browse, search, reader, progress, history, updates: never gated.' },
  sources: { tier: 'free', note: 'Never gated: charging for access to third-party content raises IP (5.2.2) risk.' },
  categories: { tier: 'free', note: 'Core organisation; gating it annoys without converting.' },
  systemNarration: { tier: 'free', note: 'System voices incl. lock screen and CarPlay audio: the funnel for HD voices.' },
  offlineDownloads: { tier: 'free', note: 'Capped by storage settings for everyone; never a paywall lever (5.2.3 risk).' },
  backupSync: { tier: 'free', note: 'Backup/restore and iCloud sync: data safety, costs us nothing.' },
  notifications: { tier: 'free', note: 'New-chapter notifications drive retention (and ad impressions).' },
  appLock: { tier: 'free', note: 'Security is never gated (Tachimanga drew complaints for it).' },
  adFree: { tier: 'pro', note: 'Pro removes every ad (interstitial, banner, rewarded prompts).' },
  hdVoices: { tier: 'pro', freeLimit: 30, note: 'On-device neural voices; free users get 30 min/day (rewarded ad: +60 min, max 3/day).' },
  lexicon: { tier: 'pro', note: 'Pronunciation lexicon editor (names in long-running novels).' },
  insights: { tier: 'pro', note: 'Reading stats/insights screen.' },
  appearancePlus: { tier: 'pro', note: 'Extra reader themes, custom colours, extra fonts. Basic themes stay free.' },
  cleanupRules: { tier: 'pro', freeLimit: 3, note: 'Text-cleanup rules: 3 free, unlimited in Pro.' },
  widget: { tier: 'pro', note: 'Home-screen widget.' },
} as const satisfies Record<string, FeatureSpec>;

export type Feature = keyof typeof FEATURES;

export interface Entitlements {
  pro: boolean;
  /** What grants Pro right now. */
  source: 'lifetime' | 'subscription' | null;
  productId?: string;
  /** Subscription expiry (epoch ms); absent for lifetime. */
  expiresAt?: number;
  inTrial?: boolean;
  /** In billing retry / grace period: keep Pro on, show a gentle banner. */
  inGracePeriod?: boolean;
}

export interface StoreProduct {
  id: string;
  displayName: string;
  description: string;
  displayPrice: string;
  price: number;
  type: 'autoRenewable' | 'nonConsumable';
  /** ISO-8601-ish period for subscriptions, e.g. "P1M", "P1Y". */
  period?: string;
  /** Eligible introductory offer (free trial) for this user, if any. */
  introOffer?: { type: 'freeTrial' | 'payAsYouGo' | 'payUpFront'; period: string; displayPrice: string };
}

export interface StorePlugin {
  products(opts: { ids: string[] }): Promise<{ products: StoreProduct[] }>;
  purchase(opts: { id: string }): Promise<{ status: 'purchased' | 'pending' | 'cancelled'; entitlements: Entitlements }>;
  /** AppStore.sync(): only on an explicit "Restore Purchases" tap (it may prompt for the Apple ID password). */
  restore(): Promise<{ entitlements: Entitlements }>;
  entitlements(): Promise<Entitlements>;
  manageSubscriptions(): Promise<void>;
  /** iOS 16+: offer-code redemption sheet. */
  redeemOfferCode(): Promise<void>;
  addListener(event: 'entitlements', fn: (e: Entitlements) => void): Promise<PluginListenerHandle>;
}

export const Store = registerPlugin<StorePlugin>('Store');

export function allowed(feature: Feature, ent: Entitlements): boolean {
  return FEATURES[feature].tier === 'free' || ent.pro;
}

/** Remaining free allowance for a metered feature (Infinity for Pro or unmetered features). */
export function remaining(feature: Feature, ent: Entitlements, used: number): number {
  const spec: FeatureSpec = FEATURES[feature];
  if (ent.pro || spec.tier === 'free') return Number.POSITIVE_INFINITY;
  return spec.freeLimit === undefined ? 0 : Math.max(0, spec.freeLimit - used);
}

export const NO_ENTITLEMENTS: Entitlements = { pro: false, source: null };
