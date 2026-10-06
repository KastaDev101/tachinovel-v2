/**
 * Ads wiring (compiled in only when built with --ads; see tools/build.ts and docs/monetization.md).
 *
 * Native side: @capacitor-community/admob (Google Mobile Ads SDK + UMP). It is NOT installed in this
 * scaffold: `npm i @capacitor-community/admob && npx cap sync ios`, then set GADApplicationIdentifier
 * and SKAdNetworkItems in Info.plist. This file talks to it through registerPlugin('AdMob') so the
 * web build does not depend on the package.
 *
 * Order at launch (Google + Apple requirements):
 *   1. UMP consent info update (EEA/UK/CH: consent form if required).
 *   2. ATT prompt only after a short explainer, never on first launch (we ask on the 2nd session).
 *   3. initialize() → preload one interstitial; show it only when AdPolicy says so.
 * Test ad units are Google's public test ids; real ids come from the AdMob account (never committed).
 */
import { registerPlugin } from '@capacitor/core';
import { observeCalls } from '../capacitor-client.ts';
import { AdPolicy, DEFAULT_AD_POLICY, emptyAdState, type AdPolicyState } from './ad-policy.ts';
import { NO_ENTITLEMENTS, Store, type Entitlements } from './entitlements.ts';

interface AdMobPlugin {
  initialize(opts?: { initializeForTesting?: boolean; testingDevices?: string[] }): Promise<void>;
  requestConsentInfo(opts?: Record<string, unknown>): Promise<{ status: string; isConsentFormAvailable?: boolean }>;
  showConsentForm(): Promise<{ status: string }>;
  trackingAuthorizationStatus(): Promise<{ status: 'authorized' | 'denied' | 'notDetermined' | 'restricted' }>;
  requestTrackingAuthorization(): Promise<void>;
  prepareInterstitial(opts: { adId: string; isTesting?: boolean }): Promise<unknown>;
  showInterstitial(): Promise<void>;
  prepareRewardVideoAd(opts: { adId: string; isTesting?: boolean }): Promise<unknown>;
  showRewardVideoAd(): Promise<{ type: string; amount: number } | undefined>;
}

const AdMob = registerPlugin<AdMobPlugin>('AdMob');

/** Google's published TEST unit ids (safe to commit). Replace via build config for production. */
export const TEST_UNITS = {
  interstitial: 'ca-app-pub-3940256099942544/4411468910',
  rewarded: 'ca-app-pub-3940256099942544/1712485313',
};

const STATE_KEY = 'tn.ads.v1';

function loadState(): AdPolicyState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return { ...emptyAdState(), ...(JSON.parse(raw) as Partial<AdPolicyState>) };
  } catch {
    // storage unavailable
  }
  return emptyAdState();
}

function saveState(s: AdPolicyState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export interface AdsController {
  /** User tapped "Watch an ad for +60 min of HD voice". Resolves true when the reward was earned. */
  showRewarded(): Promise<boolean>;
  rewardedAvailable(): boolean;
}

export async function installAds(opts: { isNarrating: () => boolean; units?: typeof TEST_UNITS }): Promise<AdsController> {
  const units = opts.units ?? TEST_UNITS;
  let ent: Entitlements = NO_ENTITLEMENTS;
  ent = await Store.entitlements().catch(() => NO_ENTITLEMENTS);
  void Store.addListener('entitlements', (e) => (ent = e));

  const policy = new AdPolicy(DEFAULT_AD_POLICY, loadState(), {
    now: () => Date.now(),
    isPro: () => ent.pro,
    isNarrating: opts.isNarrating,
  });
  policy.startSession();
  saveState(policy.snapshot());

  if (!ent.pro) {
    // 1. Consent (UMP). 2. ATT from the 2nd session on. 3. SDK init.
    const consent = await AdMob.requestConsentInfo().catch(() => null);
    if (consent?.isConsentFormAvailable && consent.status === 'REQUIRED') await AdMob.showConsentForm().catch(() => undefined);
    if (policy.snapshot().sessions >= 2) {
      const att = await AdMob.trackingAuthorizationStatus().catch(() => null);
      if (att?.status === 'notDetermined') await AdMob.requestTrackingAuthorization().catch(() => undefined);
    }
    await AdMob.initialize({ initializeForTesting: units === TEST_UNITS }).catch(() => undefined);
  }

  let interstitialReady = false;
  const preload = (): void => {
    if (ent.pro) return;
    void AdMob.prepareInterstitial({ adId: units.interstitial })
      .then(() => (interstitialReady = true))
      .catch(() => (interstitialReady = false));
  };
  preload();

  observeCalls((method) => {
    if (!policy.onCall(method) || !interstitialReady) {
      saveState(policy.snapshot());
      return;
    }
    interstitialReady = false;
    policy.recordShown();
    saveState(policy.snapshot());
    void AdMob.showInterstitial()
      .catch(() => undefined)
      .finally(preload);
  });

  return {
    rewardedAvailable: () => policy.rewardedAvailable(),
    async showRewarded() {
      if (!policy.rewardedAvailable()) return false;
      try {
        await AdMob.prepareRewardVideoAd({ adId: units.rewarded });
        const reward = await AdMob.showRewardVideoAd();
        policy.recordRewarded();
        saveState(policy.snapshot());
        return reward !== undefined;
      } catch {
        return false;
      }
    },
  };
}
