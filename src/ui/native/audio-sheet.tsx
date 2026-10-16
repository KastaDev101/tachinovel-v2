/**
 * The download sheet ("Download with audio" part 2, 2026-10-16): v1's bottom sheet (sized to its content, about half the
 * screen, so Download is always in view; grabber, drag to dismiss) from the chapter selection's Download, the novel page's "Download…" menu item and its Download with Audio
 * card. The text downloads first (v1's downloads.enqueue, unchanged); with Include Narration Audio on, Nephis makes the
 * chapters' audio on this iPhone, now or while charging (Narration.audioEnqueue). The switch and the timing are
 * remembered. The audio's size is checked against the free space (its size plus 1 GB). The first audio download asks
 * whether to send a notification when it's ready (explained first, then the system prompt; a "no" is kept).
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Button, Row, Section, Segmented, SwitchRow } from '@v1/ui/components/controls.tsx';
import { Icon } from '@v1/ui/components/icon.tsx';
import { Sheet } from '@v1/ui/components/sheet.tsx';
import { callCore } from '../capacitor-client.ts';
import { setAudio } from './audio-live.ts';
import { chapters as chapterWord, estimateWords, pickChapters, resumeIndex, spaceProblem, voiceLine, type ChapterChoice, type ChapterLike } from './audio-status.ts';
import { ExpressiveVoice } from './expressive-lab.ts';
import { Narration, type AudioEstimate, type AudioWhen } from './narration.ts';
import { confirmStep, toast } from './panel.ts';
import { dialogueValue, herDownload, narratorValue, openVoicesScreen } from './voices-ui.ts';

const INCLUDE_KEY = 'tn.audio.include';
const WHEN_KEY = 'tn.audio.when';
const ASKED_KEY = 'tn.audio.notifyAsked';

export interface DownloadRequest {
  pluginId: string;
  novelPath: string;
  name: string;
  cover?: string | undefined;
  /** The novel's chapter list (v1's ChapterView rows). */
  chapters: readonly (ChapterLike & { name?: string })[];
  lastRead?: { chapterPath: string; position?: { percent: number } } | undefined;
  /** The chapter selection's rows (indexes into `chapters`); absent: the sheet offers Next 5 · Next 10 · Unread. */
  selected?: readonly number[];
  markReadAt?: number;
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the default next time
  }
}

/** Her availability and her packs' names for the voice line (read once when the sheet opens). */
interface Voice {
  ok: boolean;
  line: string;
}

async function readVoice(): Promise<Voice> {
  const s = await ExpressiveVoice.status().catch(() => null);
  const installed = s ? herDownload(s).installed : null;
  return { ok: installed !== false, line: voiceLine(narratorValue(s), dialogueValue(s)) };
}

/** Once, at the first audio download: a short explanation, then the system prompt (respects a "no"). */
async function askNotificationsOnce(): Promise<void> {
  if (stored(ASKED_KEY)) return;
  const n = await Narration.audioNotifications().catch(() => null);
  store(ASKED_KEY, '1');
  if (!n || n.asked || (n.status !== 'notDetermined' && n.status !== 'provisional')) return;
  const yes = await confirmStep(
    'Notify You When It’s Ready?',
    'Making audio can take a while. TachiNovel can let you know when the chapters are ready to listen offline.',
    'Continue',
    false,
  );
  if (yes) await Narration.audioNotifications({ ask: true }).catch(() => undefined);
}

function DownloadSheet(props: DownloadRequest & { onDone: () => void }) {
  const [open, setOpen] = useState(true);
  const [choice, setChoice] = useState<ChapterChoice>(props.selected ? 'selected' : 'next5');
  const [include, setInclude] = useState(stored(INCLUDE_KEY) !== '0');
  const [when, setWhen] = useState<AudioWhen>(stored(WHEN_KEY) === 'charging' ? 'charging' : 'now');
  const [estimate, setEstimate] = useState<AudioEstimate | null>(null);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [busy, setBusy] = useState(false);

  const start = resumeIndex(props.chapters, props.lastRead, props.markReadAt);
  const unread = pickChapters(props.chapters, 'unread', 0).length;
  const paths = pickChapters(props.chapters, choice, start, props.selected);
  const n = paths.length;
  const audioOn = include && voice?.ok !== false;
  const space = audioOn ? spaceProblem(estimate) : null;

  useEffect(() => {
    void readVoice().then(setVoice);
  }, []);
  useEffect(() => {
    if (n === 0) return setEstimate(null);
    let alive = true;
    void Narration.audioEstimate({ pluginId: props.pluginId, novelPath: props.novelPath, chapters: n })
      .then((e) => alive && setEstimate(e))
      .catch(() => alive && setEstimate(null));
    return () => {
      alive = false;
    };
  }, [n]);

  const close = (): void => {
    setOpen(false);
    window.setTimeout(props.onDone, 450);
  };

  async function download(): Promise<void> {
    if (n === 0 || busy) return;
    setBusy(true);
    store(INCLUDE_KEY, include ? '1' : '0');
    store(WHEN_KEY, when);
    const byPath = new Map(props.chapters.map((c) => [c.path, c]));
    const text = paths.filter((p) => !byPath.get(p)?.downloaded);
    try {
      // The text first, as v1 downloads it (the audio needs it, and reading offline works at once).
      if (text.length > 0) await callCore('downloads.enqueue', { pluginId: props.pluginId, novelPath: props.novelPath, chapterPaths: text });
      if (audioOn) {
        await askNotificationsOnce();
        setAudio(
          await Narration.audioEnqueue({
            pluginId: props.pluginId,
            novelPath: props.novelPath,
            novelName: props.name,
            ...(props.cover ? { coverUrl: props.cover } : {}),
            chapters: paths,
            when,
            notify: true,
          }),
        );
      }
      toast(`Downloading ${chapterWord(n)}${audioOn ? ' with audio' : ''}`);
      close();
    } catch (err) {
      toast(`Couldn’t download: ${err instanceof Error ? err.message : String(err)}`, true);
      setBusy(false);
    }
  }

  const words = estimateWords(estimate, n);
  return (
    <Sheet open={open} onClose={close} title={`Download ${n === 1 ? '1 Chapter' : `${n} Chapters`}`} detents={['fit']} testId="audio-sheet">
      {!props.selected && (
        <div class="sheet-pad">
          <Segmented<ChapterChoice>
            label="Which chapters"
            options={[
              { value: 'next5', label: 'Next 5' },
              { value: 'next10', label: 'Next 10' },
              { value: 'unread', label: `Unread (${unread})`, aria: `Unread, ${unread} chapters` },
            ]}
            value={choice}
            onChange={setChoice}
          />
        </div>
      )}
      <Section footer="Audio is made on this iPhone, never while you’re listening. It pauses if the iPhone gets hot.">
        <SwitchRow title="Include Narration Audio" subtitle={voice ? (voice.ok ? voice.line : 'Her voice isn’t on this iPhone yet') : '…'} checked={include} onChange={setInclude} testId="audio-include" />
        {include && voice?.ok === false && (
          <Row
            title="Nephis Isn’t Available"
            subtitle="Download her voice first. The text downloads either way."
            trailing={
              <Button
                variant="tinted"
                size="small"
                onClick={() => {
                  close();
                  openVoicesScreen();
                }}
              >
                Download Her Voice
              </Button>
            }
            testId="audio-no-voice"
          />
        )}
        {audioOn && (
          <>
            <Row title="Audio Size" value={words.total || '…'} subtitle={words.detail || ' '} testId="audio-size" />
            <div class="row tn-stack" data-testid="audio-when">
              <span class="row-title">Make Audio</span>
              <Segmented<AudioWhen>
                class="row-segmented"
                label="Make Audio"
                options={[
                  { value: 'now', label: 'Now' },
                  { value: 'charging', label: 'While Charging' },
                ]}
                value={when}
                onChange={setWhen}
              />
            </div>
          </>
        )}
      </Section>
      {space && (
        <Section footer={space}>
          <Row leading={<Icon name="exclamationmark.triangle" size={20} class="tn-warn" />} title="Not Enough Space" testId="audio-space" />
        </Section>
      )}
      <div class="sheet-pad">
        <Button variant="filled" size="large" onClick={() => void download()} disabled={n === 0 || busy || space !== null}>
          {busy ? 'Starting…' : 'Download'}
        </Button>
      </div>
    </Sheet>
  );
}

/** Open the download sheet for a novel. */
export function openDownloadSheet(req: DownloadRequest): void {
  const host = document.createElement('div');
  document.body.append(host);
  const done = (): void => {
    render(null, host);
    host.remove();
  };
  render(<DownloadSheet {...req} onDone={done} />, host);
}
