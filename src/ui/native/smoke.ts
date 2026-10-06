/**
 * Simulator smoke tour (CI). Debug builds only: MainViewController injects `window.__TACHI_SMOKE__`
 * when the app is launched with `-tachiSmokeTab <tab>` / `-tachiSmokeSource <id>` (ci/ios-sim-smoke.sh),
 * and this drives the v1 UI to that screen so `simctl io screenshot` captures it. Release builds never
 * inject the global, so this is inert there.
 */
import { runVoiceSelfTest } from './voice-selftest.ts';

interface SmokeConfig {
  tab?: string;
  source?: string;
  /** "1": run the voice self-test (voice-selftest.ts) after the tour. */
  voiceSelfTest?: string;
}

declare global {
  interface Window {
    __TACHI_SMOKE__?: SmokeConfig;
  }
}

function waitFor(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = (): void => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) return resolve(el);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

export function runSmokeTour(): void {
  const cfg = window.__TACHI_SMOKE__;
  if (!cfg) return;
  void (async () => {
    if (!(await waitFor('[data-testid="screen-library"]', 20_000))) return;
    // First run shows v1's onboarding over the library: skip it like a user would.
    (await waitFor('[data-testid="onboarding-skip"]', 2500))?.click();
    await new Promise((r) => setTimeout(r, 400));
    if (cfg.tab) (await waitFor(`[data-testid="tab-${cfg.tab}"]`, 5000))?.click();
    if (cfg.source) (await waitFor(`[data-testid="source-${cfg.source}"]`, 8000))?.click();
    document.documentElement.dataset.smoke = 'done';
    if (cfg.voiceSelfTest === '1') await runVoiceSelfTest();
  })();
}
