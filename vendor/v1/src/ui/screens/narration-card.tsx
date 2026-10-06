/**
 * "Listen in the car": the shared narration state (narration.get / narration.set) and the compact card
 * on a novel page — this novel's audio status and a switch that adds it to (or removes it from) what
 * the PC narrator works on. If the script can't answer (older build), the card stays hidden.
 */
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { NarrationConfig, NarrationStatus } from '../../shared/contracts/domain.ts';
import { bridge, errorText, toUiError, type UiError } from '../bridge/client.ts';
import { Switch } from '../components/controls.tsx';
import { Icon } from '../components/icon.tsx';
import { DEFAULT_AHEAD, isNarrated, narrationLine, recentlyRead, withNovel } from '../lib/narration.ts';
import { push } from '../state/nav.ts';
import { library } from '../state/store.ts';
import { errorToast, showToast } from '../state/toast.ts';
import '../styles/extras.css';

export interface NarrationState {
  config: NarrationConfig;
  status: NarrationStatus | null;
}

export const narration = signal<NarrationState | null>(null);
export const narrationError = signal<UiError | null>(null);
let inFlight: Promise<void> | null = null;
/** Rapid edits (+ + −) each save; only the newest save's answer may touch the screen. */
let saveGen = 0;
let pendingSaves = 0;
let saveQueue: Promise<void> = Promise.resolve();
/** The last config the script accepted, to roll back to if the newest save fails. */
let accepted: NarrationConfig | null = null;

/** Loads once and shares the result; `force` refreshes (the Listen in the Car screen does on open). */
export function loadNarration(force = false): Promise<void> {
  if (inFlight) return inFlight;
  if (narration.value && !force) return Promise.resolve();
  inFlight = bridge()
    .call('narration.get')
    .then((r) => {
      accepted = r.config;
      // A save that's still on its way wins over what the script said before it.
      narration.value = pendingSaves > 0 && narration.value ? { config: narration.value.config, status: r.status } : r;
      narrationError.value = null;
    })
    .catch((err: unknown) => {
      narrationError.value = toUiError(err);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Optimistic save; rolls back with a toast if the script refuses. Saves go out one at a time, in
 * order, and a queued save that a newer edit replaces is skipped (each config is complete), so
 * quick taps (+ + −) can't land out of order or flash back to an older value.
 */
export function saveNarrationConfig(next: NarrationConfig): Promise<boolean> {
  const cur = narration.value;
  if (!cur) return Promise.resolve(false);
  accepted ??= cur.config;
  const gen = ++saveGen;
  pendingSaves++;
  narration.value = { ...cur, config: next };
  const result = saveQueue
    .then(async () => {
      if (gen !== saveGen) return true; // a newer edit carries this one
      try {
        const saved = await bridge().call('narration.set', { config: next });
        accepted = saved;
        if (gen === saveGen && narration.value) narration.value = { ...narration.value, config: saved };
        return true;
      } catch (err) {
        if (gen === saveGen && narration.value && accepted) narration.value = { ...narration.value, config: accepted };
        errorToast(`Couldn’t save: ${errorText(toUiError(err))}`);
        return false;
      }
    })
    .finally(() => {
      pendingSaves--;
    });
  saveQueue = result.then(() => undefined);
  return result;
}

/** Library novels read in the last week, newest first: what the narrator picks when nothing is picked. */
export function recentReads(): string[] {
  return recentlyRead(library.value, Date.now());
}

/** Turns narration on or off for one novel, with a toast that says what happens next. */
export async function setNovelNarrated(key: string, name: string, on: boolean): Promise<void> {
  const st = narration.value;
  if (!st) return;
  if (await saveNarrationConfig(withNovel(st.config, recentReads(), key, on))) {
    showToast(on ? `Your PC will narrate the next ${DEFAULT_AHEAD} chapters of ${name}` : `Stopped narrating ${name}`);
  }
}

export function NarrationCard(props: { pluginId: string; path: string; name: string }) {
  useEffect(() => {
    void loadNarration();
  }, []);
  const st = narration.value;
  if (!st) return narrationError.value ? null : <div class="nar-card is-loading" aria-hidden="true" />;
  const key = `${props.pluginId}:${props.path}`;
  const recent = recentReads();
  const on = isNarrated(st.config, recent, key);
  const line = narrationLine(st.config, st.status, key, recent);
  return (
    <div class="nar-card" data-testid="narration-card">
      <button type="button" class="nar-card-main tap tap-dim" onClick={() => push({ name: 'narration' })} aria-label={`Listen in the car: ${line}`}>
        <span class="nar-card-icon" aria-hidden="true">
          <Icon name="headphones" size={20} />
        </span>
        <span class="nar-card-text">
          <span class="nar-card-title">Listen in the car</span>
          <span class="nar-card-line" data-testid="narration-line">
            {line}
          </span>
        </span>
      </button>
      <Switch checked={on} onChange={(v) => void setNovelNarrated(key, props.name, v)} label={`Narrate ${props.name}`} />
    </div>
  );
}
