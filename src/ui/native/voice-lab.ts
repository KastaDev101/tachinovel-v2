/**
 * More › Developer's voice tests (developer-ui.ts): the scene-reading test (the rules and the on-device AI director
 * against labelled test scenes) and the mood test (the AI director over the chapter last started with Listen).
 * (The Kokoro Voice Lab screen that held them went on 2026-10-16: its numbers are in Developer › Voice Report.)
 */
import { htmlToBlocks } from '@v1tts/frontend.ts';
import { modelVoices, SCENE_TESTS, sceneKinds, sceneScore } from '../../core/narration/scene-tests.ts';
import { speechScript } from '../../core/narration/speech-script.ts';
import { Narration } from './narration.ts';
import { lastListened } from './speech-dom.ts';

type Obj = Record<string, unknown>;

/** More › Developer › Scene-Reading Test: the rules and the on-device AI director against the labelled test scenes. */
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

/** More › Developer › Mood Test: the on-device AI director over the chapter last started with Listen, next to the rules'
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
