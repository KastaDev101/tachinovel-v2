/**
 * More › Listen in the Car: settings for the PC narrator (novels, voice, speed, .m4b bundles), what it
 * last reported ("Updated 3h ago": the status file only changes when the narrator runs), and how the
 * audio gets to the car (iCloud Drive › TachiNovel Audio → BookPlayer → CarPlay).
 */
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { bridge } from '../bridge/client.ts';
import { BarButton, Button, Row, Section, Slider, Stepper, Switch } from '../components/controls.tsx';
import { Cover } from '../components/cover.tsx';
import { ErrorState, SkeletonRows } from '../components/feedback.tsx';
import { useNow } from '../components/hooks.ts';
import { Icon } from '../components/icon.tsx';
import { Screen } from '../components/screen.tsx';
import { relativeTime } from '../lib/format.ts';
import {
  AHEAD_CHOICES,
  AUDIO_FOLDER_URL,
  audioFolderName,
  audioFolderUrl,
  aheadFor,
  bundleLabel,
  DEFAULT_AHEAD,
  effectiveNovels,
  isNarrated,
  isStale,
  lockedLine,
  narrationLine,
  readyRanges,
  SPEED_LIMITS,
  speedLabel,
  statusFor,
  stepBundle,
  VOICES,
  withAhead,
} from '../lib/narration.ts';
import { actionSheet } from '../state/actions.ts';
import { library } from '../state/store.ts';
import { showToast } from '../state/toast.ts';
import { loadNarration, narration, narrationError, recentReads, saveNarrationConfig, setNovelNarrated } from './narration-card.tsx';
import '../styles/extras.css';

/** Set once opening Files fails (an older script refuses the link): the text hint is all that's left. */
const openFilesFailed = signal(false);

/** Opens the novel's folder in Files; if that link is refused, TachiNovel Audio itself; then gives up. */
async function openAudioFolder(novelName: string): Promise<void> {
  const urls = [...new Set([audioFolderUrl(novelName), AUDIO_FOLDER_URL])];
  for (const url of urls) {
    try {
      await bridge().call('native.openUrl', { url });
      return;
    } catch {
      // try the next one
    }
  }
  openFilesFailed.value = true;
  showToast('Couldn’t open Files. Find the audio in Files › iCloud Drive › TachiNovel Audio.');
}

const HOW_IT_WORKS = [
  'Your PC narrates overnight (or whenever you run the narrator), a few chapters ahead of where you are.',
  'The audio shows up in Files › iCloud Drive › TachiNovel Audio.',
  'Import the files into BookPlayer (free on the App Store). It plays them in CarPlay and remembers your place.',
  'Delete a file in TachiNovel Audio once it’s imported, and your PC makes room for the next batch.',
];

export function NarrationScreen() {
  useEffect(() => {
    void loadNarration(true);
  }, []);
  const st = narration.value;
  const now = useNow();
  const [speed, setSpeed] = useState<number | null>(null);

  if (!st) {
    const err = narrationError.value;
    return (
      <Screen class="is-grouped" title="Listen in the Car" back="More" testId="screen-narration">
        <div class="grouped">{err ? <ErrorState error={err} onRetry={() => void loadNarration(true)} /> : <SkeletonRows count={5} />}</div>
      </Screen>
    );
  }

  const { config, status } = st;
  // Novels narrated now (picked, or read in the last week when none are picked), then any others the
  // PC has audio or a status for.
  const recent = recentReads();
  const keys = [...new Set([...effectiveNovels(config, recent).map((n) => n.key), ...(status?.novels.map((n) => n.key) ?? [])])];
  const lib = library.value;
  const nameOf = (key: string): string => statusFor(status, key)?.name ?? lib.find((e) => e.key === key)?.name ?? key.slice(key.indexOf(':') + 1);
  const readyChapters = status?.novels.reduce((n, s) => n + s.ready.reduce((m, r) => m + (r.to - r.from + 1), 0), 0) ?? 0;

  async function addNovel(): Promise<void> {
    const candidates = [...library.value]
      .filter((e) => !isNarrated(config, recent, e.key))
      .sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))
      .slice(0, 10);
    if (candidates.length === 0) {
      showToast(library.value.length === 0 ? 'Add novels to your library first' : 'Every novel in your library is already narrated');
      return;
    }
    const i = await actionSheet({ title: 'Narrate a Novel', message: `Your PC narrates the next ${DEFAULT_AHEAD} unread chapters.`, actions: candidates.map((e) => ({ title: e.name })) });
    const pick = candidates[i];
    if (pick) await setNovelNarrated(pick.key, pick.name, true);
  }

  /** How many chapters ahead of the reader this novel is narrated (turns it on if it was off). */
  async function pickAhead(key: string, name: string): Promise<void> {
    const cur = aheadFor(config, recent, key);
    const i = await actionSheet({
      title: name,
      message: cur === undefined ? 'Narrate how far ahead of where you are?' : `Now: the next ${cur} chapters after where you are.`,
      actions: AHEAD_CHOICES.map((n) => ({ title: `Next ${n} chapters` })),
    });
    const n = AHEAD_CHOICES[i];
    if (n === undefined || n === cur) return;
    const st = narration.value;
    if (!st) return;
    if (await saveNarrationConfig(withAhead(st.config, recentReads(), key, n))) showToast(`Your PC will narrate the next ${n} chapters of ${name}`);
  }

  const stale = isStale(status, now);
  // What you're reading now, when the PC already has audio for it.
  const current = [...lib].filter((e) => e.lastReadAt !== undefined).sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))[0];
  const currentAudio = current ? statusFor(status, current.key) : undefined;

  return (
    <Screen
      class="is-grouped"
      title="Listen in the Car"
      back="More"
      testId="screen-narration"
      right={<BarButton icon="plus" label="Narrate a novel" onClick={() => void addNovel()} testId="narration-add" />}
      onRefresh={() => loadNarration(true)}
    >
      <div class="grouped">
        {status ? (
          <>
            <p class="nar-updated" data-testid="narration-updated">
              Updated {relativeTime(status.generatedAt, now)} · {readyChapters === 1 ? '1 chapter' : `${readyChapters} chapters`} ready
            </p>
            {stale && (
              <p class="nar-stale" data-testid="narration-stale">
                <Icon name="exclamationmark.triangle" size={15} />
                <span>No word from your PC since then. New audio only arrives while it’s on and the narrator runs.</span>
              </p>
            )}
          </>
        ) : (
          <div class="nar-empty" data-testid="narration-empty">
            <Icon name="headphones" size={40} class="nar-empty-icon" />
            <h2>Your PC hasn’t run the narrator yet</h2>
            <p>Pick novels and a voice below. The next time the narrator runs on your PC, audio appears in Files › iCloud Drive › TachiNovel Audio.</p>
          </div>
        )}

        {current && currentAudio && currentAudio.ready.length > 0 && (
          <div class="nar-ready" data-testid="narration-ready">
            <span class="nar-card-icon" aria-hidden="true">
              <Icon name="headphones" size={20} />
            </span>
            <span class="nar-ready-text">
              <span class="nar-ready-title">Ready for the car: {current.name}</span>
              <span class="nar-ready-line">
                Audio for {readyRanges(currentAudio.ready)} is in Files › iCloud Drive › TachiNovel Audio › {audioFolderName(currentAudio.name)}. Open it there and share it to BookPlayer.
              </span>
              {!openFilesFailed.value && (
                <Button variant="tinted" size="small" icon="folder" class="nar-ready-open" onClick={() => void openAudioFolder(currentAudio.name)} label={`Open ${currentAudio.name} audio in Files`}>
                  Open in Files
                </Button>
              )}
            </span>
          </div>
        )}

        <Section
          header="Novels"
          footer={
            config.novels.length === 0
              ? 'None picked, so your PC narrates the novels you read in the last week.'
              : 'Tap a novel to choose how far ahead of you your PC narrates. Turn one off to stop.'
          }
        >
          {keys.length === 0 ? (
            <Row title="No novels yet" subtitle="Tap + or use “Listen in the car” on a novel’s page." disabled />
          ) : (
            keys.map((key) => {
              const s = statusFor(status, key);
              const entry = lib.find((e) => e.key === key);
              const name = nameOf(key);
              const on = isNarrated(config, recent, key);
              const ahead = aheadFor(config, recent, key);
              const meta = [on && ahead !== undefined ? `Next ${ahead} chapters` : '', s?.lastRunAt !== undefined ? `Last run ${relativeTime(s.lastRunAt, now)}` : '']
                .filter(Boolean)
                .join(' · ');
              return (
                <div class="row nar-novel" key={key} data-testid="narration-novel">
                  <button type="button" class="nar-novel-main tap tap-dim" onClick={() => void pickAhead(key, name)} aria-label={`${name}: ${narrationLine(config, status, key, recent)}. Choose how far ahead to narrate`}>
                    <Cover src={entry?.cover} pluginId={key.slice(0, key.indexOf(':'))} class="cover-thumb" />
                    <span class="row-main">
                      <span class="row-title">{name}</span>
                      <span class="row-subtitle nar-line">{narrationLine(config, status, key, recent)}</span>
                      {meta && <span class="row-subtitle">{meta}</span>}
                      {lockedLine(s) && (
                        <span class="row-subtitle nar-locked" data-testid="narration-locked">
                          <Icon name="lock.fill" size={11} />
                          {lockedLine(s)}
                        </span>
                      )}
                      {s?.error && <span class="row-subtitle nar-error">{s.error}</span>}
                    </span>
                  </button>
                  <Switch checked={on} onChange={(v) => void setNovelNarrated(key, name, v)} label={`Narrate ${name}`} />
                </div>
              );
            })
          )}
        </Section>

        <Section header="Voice">
          <div class="nar-voices" role="radiogroup" aria-label="Voice">
          {VOICES.map((v) => {
            const on = config.voice === v.id;
            return (
              <button
                type="button"
                class="row tap tap-row nar-voice"
                key={v.id}
                role="radio"
                aria-checked={on}
                onClick={() => void saveNarrationConfig({ ...config, voice: v.id })}
                data-testid={`voice-${v.id}`}
              >
                <span class="row-main">
                  <span class="row-title">{v.name}</span>
                  <span class="row-subtitle">{v.description}</span>
                </span>
                <span class={`row-check${on ? ' is-on' : ''}`}>
                  <Icon name="checkmark" size={17} />
                </span>
              </button>
            );
          })}
          </div>
        </Section>

        <Section header="Speed" footer="Applies to chapters narrated from now on.">
          <div class="row nar-speed">
            <Icon name="minus" size={14} class="nar-speed-end" />
            <Slider
              label="Narration speed"
              min={SPEED_LIMITS.min}
              max={SPEED_LIMITS.max}
              step={SPEED_LIMITS.step}
              value={speed ?? config.speed}
              onInput={setSpeed}
              onCommit={(v) => {
                setSpeed(null);
                void saveNarrationConfig({ ...config, speed: Math.round(v * 100) / 100 });
              }}
            />
            <Icon name="plus" size={14} class="nar-speed-end" />
            <span class="nar-speed-value tabular" data-testid="narration-speed">
              {speedLabel(speed ?? config.speed)}
            </span>
          </div>
        </Section>

        <Section
          header="Audiobook Files"
          footer={
            config.bundle === 0
              ? 'Off: one audio file per chapter.'
              : `${config.bundle} chapters per .m4b audiobook, with chapter marks. Fewer files to import.`
          }
        >
          <div class="row" data-testid="narration-bundle">
            <span class="row-main">
              <span class="row-title">Bundle chapters (.m4b)</span>
            </span>
            <Stepper
              label="Chapters per file"
              value={config.bundle}
              min={0}
              max={20}
              step={1}
              format={bundleLabel}
              onChange={(v) => void saveNarrationConfig({ ...config, bundle: stepBundle(config.bundle, v) })}
            />
          </div>
        </Section>

        <Section header="How It Works">
          <ol class="nar-how">
            {HOW_IT_WORKS.map((t, i) => (
              <li key={i}>
                <span class="nar-how-n tabular" aria-hidden="true">
                  {i + 1}
                </span>
                <span>{t}</span>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </Screen>
  );
}
