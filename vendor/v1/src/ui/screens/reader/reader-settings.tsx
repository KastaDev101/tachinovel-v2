/** Reader appearance controls (used in the reader's sheet and in More › Reader). */
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import type { ReaderFont, ReaderSettings, ReaderTheme } from '../../../shared/contracts/domain.ts';
import { Section, Segmented, SelectRow, Slider, Stepper, SwitchRow } from '../../components/controls.tsx';
import { Icon } from '../../components/icon.tsx';
import { justifyFits as fitsJustify } from '../../lib/justify.ts';
import { READER_LIMITS } from '../../state/defaults.ts';
import { patchSettings, settings } from '../../state/store.ts';

export const THEMES: { value: ReaderTheme; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'dark', label: 'Dark' },
  { value: 'black', label: 'Black' },
];

export const FONTS: { value: ReaderFont; label: string; family: string }[] = [
  { value: 'serif', label: 'New York', family: 'ui-serif, "New York", Georgia, serif' },
  { value: 'sans', label: 'SF Pro', family: '-apple-system, system-ui, sans-serif' },
  { value: 'rounded', label: 'Rounded', family: 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif' },
  { value: 'georgia', label: 'Georgia', family: 'Georgia, "Times New Roman", serif' },
];

export function fontFamily(f: ReaderFont): string {
  return FONTS.find((x) => x.value === f)?.family ?? FONTS[0]?.family ?? 'serif';
}

export type InfoPillMode = 'doubletap' | 'always' | 'never';

const PILL_KEY = 'tachinovel.infoPill';

function readPillPref(): 'doubletap' | 'always' {
  try {
    return localStorage.getItem(PILL_KEY) === 'always' ? 'always' : 'doubletap';
  } catch {
    return 'doubletap';
  }
}

/**
 * "Info pill" setting. The settings contract only has `showFooter` (false = Never); the choice
 * between Double-tap (default — showFooter: true was never a user choice) and Always lives in the UI.
 */
const pillPref = signal<'doubletap' | 'always'>(readPillPref());

export function infoPillMode(showFooter: boolean): InfoPillMode {
  return showFooter ? pillPref.value : 'never';
}

/**
 * Hyphenation: 'auto' hyphenates only justified text (it evens out the gaps justify makes); 'on' /
 * 'off' always / never. A per-device preference (the settings contract has no field for it).
 */
export type HyphenMode = 'auto' | 'on' | 'off';
const HYPHEN_KEY = 'tachinovel.hyphens';

function readHyphenPref(): HyphenMode {
  try {
    const v = localStorage.getItem(HYPHEN_KEY);
    return v === 'on' || v === 'off' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export const hyphenPref = signal<HyphenMode>(readHyphenPref());

export function setHyphenMode(mode: HyphenMode): void {
  hyphenPref.value = mode;
  try {
    localStorage.setItem(HYPHEN_KEY, mode);
  } catch {
    // private mode / blocked storage: the choice lasts for this session
  }
}

/** Justify only where the lines are long enough (see lib/justify.ts). */
export function justifyFits(r: Pick<ReaderSettings, 'fontSize' | 'margin' | 'justify'>, viewportWidth: number): boolean {
  return fitsJustify(r, viewportWidth, hyphenates(r.justify));
}

/** Whether chapter text is hyphenated with these settings. */
export function hyphenates(justify: boolean): boolean {
  const m = hyphenPref.value;
  return m === 'on' || (m === 'auto' && justify);
}

export function setInfoPillMode(mode: InfoPillMode): void {
  if (mode !== 'never') {
    pillPref.value = mode;
    try {
      localStorage.setItem(PILL_KEY, mode);
    } catch {
      // private mode / blocked storage: the choice lasts for this session
    }
  }
  setReader({ showFooter: mode !== 'never' }, 0);
}

export function setReader(patch: Partial<ReaderSettings>, debounceMs = 350): void {
  patchSettings({ reader: patch }, debounceMs);
}

export function ReaderSettingsPanel(props: { onBrightness?: (v: number | null) => void; showBrightness?: boolean }) {
  const r = settings.value.reader;
  /** Slider value while dragging: the screen follows live, the setting is saved once on release. */
  const [dragBrightness, setDragBrightness] = useState<number | null>(null);
  return (
    <div class="reader-settings" data-testid="reader-settings">
      {props.showBrightness !== false && (
        <div class="rs-brightness">
          <Icon name="sun.min" size={18} />
          <Slider
            label="Brightness"
            value={dragBrightness ?? r.brightness ?? 0.6}
            min={0.02}
            max={1}
            step={0.01}
            class={r.brightness === null && dragBrightness === null ? 'is-auto' : ''}
            valueText={r.brightness === null && dragBrightness === null ? 'System' : `${Math.round((dragBrightness ?? r.brightness ?? 0.6) * 100)} percent`}
            onInput={(v) => {
              setDragBrightness(v);
              props.onBrightness?.(v);
            }}
            onCommit={(v) => {
              setDragBrightness(null);
              setReader({ brightness: v }, 0);
              props.onBrightness?.(v);
            }}
          />
          <Icon name="sun.max" size={22} />
          <button
            type="button"
            class={`rs-auto tap tap-dim${r.brightness === null ? ' is-on' : ''}`}
            onClick={() => {
              const next = r.brightness === null ? 0.6 : null;
              setReader({ brightness: next }, 0);
              props.onBrightness?.(next);
            }}
            aria-pressed={r.brightness === null}
          >
            System
          </button>
        </div>
      )}
      <div class="rs-themes" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => (
          <button
            type="button"
            role="radio"
            aria-checked={r.theme === t.value}
            class={`rs-theme tap tap-scale is-${t.value}${r.theme === t.value ? ' is-selected' : ''}`}
            key={t.value}
            onClick={() => setReader({ theme: t.value }, 0)}
            data-testid={`theme-${t.value}`}
          >
            <span class="rs-swatch">Aa</span>
            <span class="rs-theme-label">{t.label}</span>
          </button>
        ))}
      </div>
      <div class="sheet-pad">
        <Segmented
          class="rs-fonts"
          options={FONTS.map((f) => ({ value: f.value, label: <span style={{ fontFamily: f.family }}>{f.label}</span>, aria: f.label }))}
          value={r.font}
          onChange={(font) => setReader({ font }, 0)}
        />
      </div>
      <Section>
        <div class="row">
          <span class="row-main">
            <span class="row-title">Text size</span>
          </span>
          <Stepper label="Text size" value={r.fontSize} {...READER_LIMITS.fontSize} onChange={(fontSize) => setReader({ fontSize })} format={(v) => `${v}`} />
        </div>
        <div class="row">
          <span class="row-main">
            <span class="row-title">Line spacing</span>
          </span>
          <Stepper label="Line spacing" value={r.lineHeight} {...READER_LIMITS.lineHeight} onChange={(lineHeight) => setReader({ lineHeight })} format={(v) => v.toFixed(1)} />
        </div>
        <div class="row">
          <span class="row-main">
            <span class="row-title">Paragraph spacing</span>
          </span>
          <Stepper
            label="Paragraph spacing"
            value={r.paragraphSpacing}
            {...READER_LIMITS.paragraphSpacing}
            onChange={(paragraphSpacing) => setReader({ paragraphSpacing })}
            format={(v) => v.toFixed(1)}
          />
        </div>
        <div class="row">
          <span class="row-main">
            <span class="row-title">Margins</span>
          </span>
          <Stepper label="Margins" value={r.margin} {...READER_LIMITS.margin} onChange={(margin) => setReader({ margin })} />
        </div>
      </Section>
      <Section>
        <SwitchRow
          title="Justify text"
          {...(r.justify && !justifyFits(r, window.innerWidth) ? { subtitle: 'Paused at this text size: the lines are too short to justify without gaps' } : {})}
          checked={r.justify}
          onChange={(justify) => setReader({ justify }, 0)}
          testId="rs-justify"
        />
        <SwitchRow title="Indent paragraphs" checked={r.indent} onChange={(indent) => setReader({ indent }, 0)} testId="rs-indent" />
        <SelectRow
          title="Hyphenation"
          value={hyphenPref.value}
          options={[
            { value: 'auto', label: 'With justified text' },
            { value: 'on', label: 'Always' },
            { value: 'off', label: 'Never' },
          ]}
          onChange={setHyphenMode}
          testId="rs-hyphens"
        />
      </Section>
      <Section footer={r.paged ? 'Swipe or tap the left and right edges to turn pages; the last page of a chapter turns into the next one.' : undefined}>
        <div class="row" data-testid="rs-page-mode">
          <Segmented
            class="row-segmented"
            options={[
              { value: 'scroll', label: 'Scroll' },
              { value: 'pages', label: 'Pages' },
            ]}
            value={r.paged ? 'pages' : 'scroll'}
            onChange={(v) => setReader({ paged: v === 'pages' }, 0)}
            label="Page turning"
          />
        </div>
      </Section>
      <Section footer="Tap the middle of the page to show or hide the controls; with tap zones, the left and right edges scroll a screen. Double-tap shows the time, battery and chapter progress.">
        <SwitchRow title="Tap zones" checked={r.tapZones} onChange={(tapZones) => setReader({ tapZones }, 0)} />
        <SwitchRow title="Continuous scrolling" subtitle="Keep reading into the next chapter" checked={r.continuous} onChange={(continuous) => setReader({ continuous }, 0)} />
        <SwitchRow title="Keep screen awake" checked={r.keepAwake} onChange={(keepAwake) => setReader({ keepAwake }, 0)} />
        <SelectRow
          title="Info pill"
          value={infoPillMode(r.showFooter)}
          options={[
            { value: 'doubletap', label: 'Double-tap' },
            { value: 'always', label: 'Always' },
            { value: 'never', label: 'Never' },
          ]}
          onChange={setInfoPillMode}
          testId="rs-info-pill"
        />
      </Section>
    </div>
  );
}
