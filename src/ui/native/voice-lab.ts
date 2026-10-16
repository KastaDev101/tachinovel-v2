/**
 * Voice Lab (More › Developer › Legacy › Kokoro Voice Lab). Live numbers from the on-device voice
 * for tonight's phone test: whether the crash safety fallback tripped, where Core ML runs each Kokoro stage
 * (Neural Engine / CPU / GPU, from its compute plan), time to first audio, per-sentence real-time factor,
 * model load (cold/warm), memory, thermal state and fallbacks to the Apple voice. "Copy report" puts it
 * all on the clipboard as JSON. The numbers refresh once a second only while narration plays.
 */
import { htmlToBlocks, type SourceBlock } from '@v1tts/frontend.ts';
import { modelVoices, SCENE_TESTS, sceneKinds, sceneScore } from '../../core/narration/scene-tests.ts';
import { speechScript } from '../../core/narration/speech-script.ts';
import { openExpressiveLab } from './expressive-lab.ts';
import { Narration, type NarratorInfo } from './narration.ts';
import { panel } from './panel.ts';
import { lastListened } from './speech-dom.ts';

/** Synthetic chapter for "Speak test paragraph" (and the simulator self-test): no novel, no progress. */
export const LAB_PLUGIN = 'voice-lab';

export const TEST_PARAGRAPHS = [
  'Chapter 12 - The Old Bridge',
  'The rain had stopped by the time Sunny reached the old bridge. He counted the lanterns, all 304 of them, and wondered who had lit them.',
  '“Wait,” Nephis said quietly. “Are you sure this is the way?” Tsk. He didn’t answer; the river answered for him, loud and cold beneath the stones.',
  'Somewhere far behind them, a bell rang three times. They walked on.',
];

export function labScript(paragraphs = TEST_PARAGRAPHS): ReturnType<typeof speechScript> {
  const blocks: SourceBlock[] = paragraphs.map((text) => ({ text, tag: 'p' }));
  return speechScript(blocks, { title: 'The Old Bridge', lexicons: [{ schemaVersion: 1, entries: [{ match: 'Nephis', ipa: 'nˈɛfɪs' }] }] });
}

/**
 * Speak the test passage (dialogue, a lexicon name, numbers): as the settings say, or for an A/B with
 * narrator mode off ('off') or on with the saved pieces ('on') for this play only.
 */
export function playTestPassage(narrator?: 'on' | 'off'): Promise<void> {
  return Narration.play({
    pluginId: LAB_PLUGIN,
    novelPath: 'lab',
    chapterPath: 'lab/1',
    novelName: 'Voice Lab',
    chapterName: narrator === 'on' ? 'Test passage · narrator mode' : narrator === 'off' ? 'Test passage · plain' : 'Test paragraph',
    script: labScript(),
    start: { paragraph: 0 },
    autoContinue: false,
    engine: 'speech',
    ...(narrator ? { narrator } : {}),
  });
}

/** Narrator mode's pieces, for switches (Settings › Voices and the Voice Lab). */
export const NARRATOR_PIECES = [
  ['pacing', 'Natural pauses', 'Pauses follow the punctuation and the conversation'],
  ['jitter', 'Natural variation', 'Each sentence a touch faster or slower'],
  ['polish', 'Studio sound', 'EQ, gentle compression, even loudness (−16 LUFS)'],
  ['roomTone', 'Room tone', 'A faint room sound instead of dead silence'],
] as const;

function fmt(x: unknown, digits = 0, unit = ''): string {
  return typeof x === 'number' && Number.isFinite(x) ? `${x.toFixed(digits)}${unit}` : '–';
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

type Obj = Record<string, unknown>;
/** A string or number from the lab JSON as text, else the fallback. */
const str = (x: unknown, fallback = '–'): string => (typeof x === 'string' || typeof x === 'number' ? String(x) : fallback);
const obj = (x: unknown): Obj => (x && typeof x === 'object' ? (x as Obj) : {});

let open = false;

/** Voice Lab › Test scene reading: the rules and the on-device AI director against the labelled test scenes. */
export async function sceneReadingTest(): Promise<string> {
  let rules = 0;
  let ai = 0;
  let total = 0;
  let ms = 0;
  let note = '';
  for (const t of SCENE_TESTS) {
    const items = speechScript(htmlToBlocks(t.paragraphs.map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join(''))).items;
    const kinds = sceneKinds(items);
    rules += sceneScore(items.map((i) => i.voice), t.labels).ok;
    total += items.length;
    const r = await Narration.readScene({ sentences: items.map((i, k) => ({ text: i.text, kind: kinds[k] ?? 'narration' })) }).catch(() => null);
    if (!r?.moods) {
      note = r?.reason ?? 'not available';
      continue;
    }
    ms += r.ms;
    ai += sceneScore(modelVoices(items, kinds, r.moods), t.labels).ok;
  }
  const pct = (n: number): string => `${Math.round((1000 * n) / Math.max(1, total)) / 10} %`;
  return `Rules ${pct(rules)} · AI ${note ? `— (${note})` : `${pct(ai)} in ${(ms / 1000).toFixed(1)} s`} · ${total} sentences`;
}

/** Voice Lab › Test moods: the on-device AI director over the chapter last started with Listen, next to the rules'
 * moods. The report (copy it) scores against hand labels on the PC; it holds only each sentence's first words. */
export async function chapterMoodTest(): Promise<{ summary: string; report: Obj | null }> {
  const last = lastListened();
  if (!last) return { summary: 'Start Listen on a chapter first, then come back here.', report: null };
  const items = last.script.items;
  const kinds = sceneKinds(items);
  const r = await Narration.readScene({ sentences: items.map((i, k) => ({ text: i.text, kind: kinds[k] ?? 'narration' })) }).catch(() => null);
  const rules = items.map((i) => i.mood ?? 'calm');
  const count = (list: readonly string[]): string => {
    const c = new Map<string, number>();
    for (const m of list) c.set(m, (c.get(m) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', ');
  };
  const report: Obj = { chapter: last.chapter, sentences: items.length, ai: r?.moods ?? null, aiNote: r?.moods ? null : (r?.reason ?? 'not available'),
    ms: Math.round(r?.ms ?? 0), rules, kinds, first: items.map((i) => i.text.slice(0, 40)) };
  const ai = r?.moods ? `AI: ${count(r.moods)} (${((r.ms ?? 0) / 1000).toFixed(1)} s)` : `AI — (${r?.reason ?? 'not available'})`;
  return { summary: `${last.chapter} · ${items.length} sentences · ${ai} · Rules: ${count(rules)}`, report };
}

export function openVoiceLab(): void {
  if (open) return;
  open = true;
  const pn = panel('Voice Lab', 'voice-lab');
  const root = pn.root;
  root.classList.add('lab');
  const body = pn.body;
  let lab: Obj = {};
  let sceneResult = 'not run yet';
  let moodResult = 'not run yet';
  let moodReport: Obj | null = null;
  let poll = 0;
  let nar: NarratorInfo | null = null;
  let dialogueName = '';
  const loadNarrator = async (): Promise<void> => {
    const s = await Narration.voiceSettings().catch(() => null);
    nar = s?.narrator ?? null;
    const id = nar?.dialogueVoice;
    dialogueName = id ? (s?.voices.find((v) => v.id === id)?.name ?? s?.customVoices?.find((m) => m.id === id)?.name ?? id) : '';
    render();
  };

  const render = (): void => {
    const k = obj(lab.kokoro);
    const stats = obj(lab.stats);
    const dev = obj(lab.device);
    const ses = obj(lab.session);
    const crashes = obj(lab.crashes);
    const model = obj(k.model);
    const routes = Array.isArray(lab.routes) ? (lab.routes as Obj[]) : [];
    const first = Array.isArray(stats.firstAudio) ? (stats.firstAudio as Obj[]) : [];
    const rows = Array.isArray(stats.sentences) ? (stats.sentences as Obj[]).slice(-20).reverse() : [];
    const stages = obj(k.stages);
    const fallbacks = obj(ses.fallbacks);
    const lastFirst = first[first.length - 1];
    const placement = Array.isArray(lab.placement) ? (lab.placement as Obj[]) : [];
    const car = obj(lab.car);
    const np = obj(car.nowPlaying);
    const cmds = obj(car.commands);
    const gaps = Array.isArray(car.chapterGapsMs) ? (car.chapterGapsMs as number[]) : [];
    const tripped = crashes.disabled === true;
    const crashCount = typeof crashes.total === 'number' ? crashes.total : 0;
    body.innerHTML = `
      <h2>Safety fallback</h2>
      <div class="kv">
        <span>Status</span><span class="big">${tripped ? 'TRIPPED: Kokoro off' : crashCount > 0 ? `armed (${crashCount} crash${crashCount === 1 ? '' : 'es'})` : 'not tripped'}</span>
        <span>Crashes in Core ML</span><span>${fmt(crashes.total)} total, ${fmt(crashes.consecutive)} in a row${crashes.lastAt ? ` · last ${esc(str(crashes.lastAt))}` : ''}</span>
        <span>Last crash during</span><span>${esc(str(crashes.lastContext, '–'))}</span>
      </div>
      <h2>Where each stage runs (Core ML plan)</h2>
      <div class="kv">${placement.length > 0 ? placement.map((p) => `<span>${esc(str(p.stage))}</span><span>${p.error ? esc(str(p.error)) : `${esc(str(p.configured))} → ANE ${fmt(p.ane)} · CPU ${fmt(p.cpu)} · GPU ${fmt(p.gpu)} ops`}</span>`).join('') : '<span>–</span><span>Tap “Check placement”</span>'}</div>
      <div class="acts"><button type="button" data-act="placement">Check Placement</button></div>
      <h2>Now</h2>
      <div class="kv">
        <span>Time to first audio</span><span class="big">${lastFirst ? `${fmt(lastFirst.ms)} ms` : '–'}</span>
        <span>…from</span><span>${esc(str(lastFirst?.source, '–'))}</span>
        <span>Speed (all sentences)</span><span class="big">${fmt(stats.aggregateX, 1, '× real time')}</span>
        <span>Median / slowest 5%</span><span>${fmt(stats.p50X, 1, '×')} / ${fmt(stats.p05X, 1, '×')}</span>
        <span>Sentences / failures</span><span>${fmt(stats.totalSentences)} / ${fmt(stats.failures)}</span>
      </div>
      <h2>Kokoro</h2>
      <div class="kv">
        <span>Status</span><span>${esc(str(k.status, '–'))}</span>
        <span>Model load</span><span>${fmt(k.lastLoadMs)} ms${k.lastLoadCold ? ' (cold: first load this launch)' : ''}</span>
        <span>Model</span><span>${esc(str(model.revision, '–').slice(0, 10))} · ${fmt(typeof model.bytes === 'number' ? model.bytes / 1e6 : undefined, 0, ' MB')}</span>
        <span>Render ahead</span><span>${fmt(k.ahead)} sentences</span>
        <span>Stages</span><span>${Object.entries(stages).map(([s, u]) => `${esc(s)} ${esc(String(u))}`).join(', ')}</span>
        <span>Memory releases</span><span>${fmt(k.memoryReleases)}</span>
      </div>
      <div class="acts">${routes.map((r) => `<button type="button" data-act="route" data-v="${esc(String(r.id))}" class="${r.id === k.route ? 'on' : ''}">${esc(String(r.title))}</button>`).join('')}</div>
      <div class="acts">${[2, 3].map((n) => `<button type="button" data-act="ahead" data-v="${n}" class="${n === k.ahead ? 'on' : ''}">Ahead ${n}</button>`).join('')}</div>
      <h2>This session</h2>
      <div class="kv">
        <span>Speaking</span><span>${esc(str(ses.source, '–'))}${ses.lastFallback ? ` (${esc(str(ses.lastFallback))})` : ''}</span>
        <span>Kokoro / Apple sentences</span><span>${fmt(ses.kokoroSentences)} / ${fmt(ses.appleSentences)}</span>
        <span>Queue ran dry</span><span>${fmt(ses.underruns)}</span>
        <span>Fallbacks</span><span>${Object.entries(fallbacks).map(([r, n]) => `${esc(r)} ${String(n)}`).join(', ') || 'none'}</span>
        <span>Back to Kokoro</span><span>${fmt(ses.returnsToKokoro)}</span>
        <span>Thermal throttling</span><span>${ses.throttled ? 'on' : 'off'}</span>
      </div>
      <h2>In the car (Now Playing)</h2>
      <div class="kv">
        <span>Showing</span><span>${np.title ? `${esc(str(np.title))} · ${esc(str(np.artist, ''))} · ${esc(str(np.album, ''))}` : 'nothing'}</span>
        <span>Time / length</span><span>${fmt(np.shownNow ?? np.elapsed, 0, ' s')} / ${fmt(np.duration, 0, ' s')} at ${fmt(np.rate, 2, '×')}${np.artwork ? ' · cover' : ''}</span>
        <span>Car buttons</span><span>${cmds.buttons === 'skip15' ? '±15 s' : 'chapters'} (${['nextTrack', 'previousTrack', 'skipForward', 'skipBackward', 'changePlaybackPosition'].filter((c) => cmds[c] === true).join(', ') || 'none yet'})</span>
        <span>Last commands</span><span>${Array.isArray(cmds.recent) ? esc((cmds.recent as string[]).slice(-6).join(', ')) || '–' : '–'}</span>
        <span>Chapter changes</span><span>${gaps.length > 0 ? `${gaps.map((g) => `${Math.round(g)} ms`).join(', ')} of silence` : '–'}</span>
        <span>Prepared audio</span><span>${fmt(car.preparedChapters)} chapters · ${fmt(typeof car.preparedBytes === 'number' ? car.preparedBytes / 1e6 : undefined, 0, ' MB')}</span>
        <span>CarPlay app</span><span>${car.carPlayTemplates === true ? 'on' : 'off (needs Apple’s CarPlay audio entitlement)'}</span>
      </div>
      <h2>Device</h2>
      <div class="kv">
        <span>iPhone</span><span>${esc(str(dev.model, '–'))} · ${esc(str(dev.os, ''))}</span>
        <span>Compute units</span><span>${Array.isArray(dev.computeDevices) ? esc((dev.computeDevices as string[]).join(', ')) : '–'}</span>
        <span>Memory (app)</span><span>${fmt(dev.memoryMB, 0, ' MB')} · ${fmt(dev.availableMB, 0, ' MB')} available</span>
        <span>Thermal</span><span>${esc(str(dev.thermal, '–'))}${dev.lowPower ? ' · Low Power Mode' : ''}</span>
        <span>Battery</span><span>${typeof dev.battery === 'number' && dev.battery >= 0 ? `${Math.round(dev.battery * 100)}%` : '–'}</span>
        <span>Crashes in Kokoro</span><span>${fmt(crashes.total)}${crashes.disabled ? ' · Kokoro turned off' : ''}${crashes.lastAt ? ` · last ${esc(str(crashes.lastAt))}` : ''}</span>
      </div>
      <h2>Time to first audio (last ${first.length})</h2>
      <div class="kv">${first
        .slice()
        .reverse()
        .map((f) => `<span>${esc(str(f.at, '').slice(11, 19))}</span><span>${fmt(f.ms)} ms · ${esc(str(f.source, ''))}</span>`)
        .join('') || '<span>–</span><span></span>'}</div>
      <h2>Sentences (newest first)</h2>
      <table class="lab-t"><tr><th>#</th><th>chars</th><th>synth</th><th>audio</th><th>× RT</th><th>RTF</th></tr>
      ${rows.map((r) => `<tr><td>${fmt(r.index)}</td><td>${fmt(r.chars)}</td><td>${fmt(r.synthMs)} ms</td><td>${fmt(typeof r.audioMs === 'number' ? r.audioMs / 1000 : undefined, 1)} s</td><td>${fmt(r.x, 1)}</td><td>${fmt(r.rtf, 3)}</td></tr>`).join('')}</table>
      <h2>Narrator mode A/B</h2>
      <div class="kv"><span>Dialogue voice</span><span>${esc(dialogueName || 'the narrator’s (set one in Settings › Voices › Narrator mode)')}</span>
        <span>Saved</span><span>${nar?.enabled ? 'on' : 'off'}</span></div>
      <div class="acts" data-testid="lab-narrator">${NARRATOR_PIECES.map(([k, label]) => `<button type="button" data-act="nar-piece" data-k="${k}" class="${nar?.[k] ? 'on' : ''}" aria-pressed="${String(!!nar?.[k])}">${label}</button>`).join('')}</div>
      <div class="acts">
        <button type="button" data-act="ab" data-v="off">A: Narrator Off</button>
        <button type="button" data-act="ab" data-v="on">B: Narrator On</button>
      </div>
      <div class="acts">
        <button type="button" data-act="test">Speak Test Paragraph</button>
        <button type="button" data-act="stop">Stop</button>
        <button type="button" data-act="reset">Reset Numbers</button>
        <button type="button" data-act="copy">Copy Report</button>
      </div>
      <h2>Scene reading</h2>
      <div class="kv" data-testid="lab-scene"><span>Accuracy</span><span>${esc(sceneResult)}</span></div>
      <div class="acts"><button type="button" data-act="scene-test">Test Scene Reading</button></div>
      <div class="kv" data-testid="lab-moods"><span>Moods</span><span>${esc(moodResult)}</span></div>
      <div class="acts"><button type="button" data-act="mood-test">Test Moods on the Last Chapter</button>
        ${moodReport ? '<button type="button" data-act="mood-copy">Copy Mood Report</button>' : ''}</div>
      <h2>Experimental</h2>
      <div class="acts"><button type="button" data-act="expressive">Experimental Engines</button></div>`;
  };

  const refresh = async (): Promise<void> => {
    lab = obj(await Narration.voiceLab().catch(() => ({})));
    render();
  };

  root.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    switch (el.dataset.act ?? '') {
      case 'route':
        void Narration.setVoiceLab({ route: el.dataset.v ?? 'ane-cpu' }).then(refresh);
        return;
      case 'ahead':
        void Narration.setVoiceLab({ ahead: Number(el.dataset.v) }).then(refresh);
        return;
      case 'reset':
        void Narration.setVoiceLab({ resetStats: true }).then(refresh);
        return;
      case 'placement':
        el.textContent = 'Checking…';
        void Narration.voicePlacement()
          .then(refresh)
          .catch(() => (el.textContent = 'Check failed'));
        return;
      case 'stop':
        void Narration.stop();
        return;
      case 'expressive':
        openExpressiveLab();
        return;
      case 'scene-test':
        sceneResult = 'Reading the test scenes…';
        render();
        void sceneReadingTest().then((r) => {
          sceneResult = r;
          render();
        });
        return;
      case 'test':
        void playTestPassage();
        return;
      case 'ab':
        void playTestPassage(el.dataset.v === 'on' ? 'on' : 'off');
        return;
      case 'nar-piece': {
        const k = el.dataset.k as keyof NarratorInfo | undefined;
        if (!k || !nar) return;
        void Narration.setVoiceSettings({ narrator: { [k]: !nar[k] } }).then(loadNarrator);
        return;
      }
      case 'mood-test':
        moodResult = 'Reading the chapter…';
        moodReport = null;
        render();
        void chapterMoodTest().then((r) => {
          moodResult = r.summary;
          moodReport = r.report;
          render();
        });
        return;
      case 'mood-copy':
        void navigator.clipboard
          .writeText(JSON.stringify(moodReport))
          .then(() => (el.textContent = 'Copied'))
          .catch(() => (el.textContent = 'Copy failed'));
        return;
      case 'copy':
        void navigator.clipboard
          .writeText(JSON.stringify(lab, null, 2))
          .then(() => (el.textContent = 'Copied'))
          .catch(() => (el.textContent = 'Copy failed'));
        return;
      default:
    }
  });
  render();
  void refresh();
  void loadNarrator();
  void Narration.voicePlacement()
    .then(refresh)
    .catch(() => undefined);
  // Live numbers while narration plays (a test passage, Listen); one last read when it stops.
  let live = false;
  const follow = (status: string | undefined): void => {
    const now = status === 'playing' || status === 'loading';
    if (now === live) return;
    live = now;
    window.clearInterval(poll);
    if (live) poll = window.setInterval(() => void refresh(), 1000);
    else void refresh();
  };
  const handle = Narration.addListener('state', (st) => follow(st.status)).catch(() => null);
  void Narration.state()
    .then((st) => follow(st.status))
    .catch(() => undefined);
  pn.onClose(() => {
    open = false;
    window.clearInterval(poll);
    void handle.then((h) => h?.remove());
  });
}
