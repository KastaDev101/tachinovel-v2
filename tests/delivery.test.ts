/**
 * Natural delivery, script side (src/core/narration/delivery.ts through speechScript): whole-sentence and
 * breath-group feeding, the director (dialogue tags, punctuation, emphasis, line classes, non-verbals, scene mood,
 * system messages), Nano's parameters, the context pauses and breath points. Prose fixtures are public domain
 * (Lewis Carroll, Arthur Conan Doyle) or written for this test in the style of web novels.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlToBlocks } from '@v1tts/frontend.ts';
import {
  alignEmphasis,
  breathPoint,
  CENTS_RANGE,
  CHUNK_MAX_CHARS,
  CLASS_TABLE,
  deliverLines,
  deliveryParams,
  direct,
  DELIVERY_AUDIO,
  DIALOGUE_LIFT_T,
  ELLIPSIS_PAUSE,
  GAIN_RANGE_DB,
  INTENSE_PAUSE,
  lastContentWord,
  LINE_CLASSES,
  MIN_TAG_GAP,
  MOOD_TABLE,
  MOODS,
  nanoText,
  naturalPause,
  NON_VERBALS,
  PAUSE_JITTER,
  PAUSE_MODEL,
  pauseContext,
  pauseJitter,
  pauseSeed,
  planChunks,
  quoteSplit,
  smoothScenes,
  speechShape,
  syllables,
  TEASING_CHUCKLE_EVERY,
  TEMPERATURE_RANGE,
  TEMPO_LIMITS,
  type Cue,
  type DirectorSentence,
  type PauseSide,
} from '../src/core/narration/delivery.ts';
import { segmentKind } from '../src/core/narration/segment.ts';
import { speechScript, type SpeechItem } from '../src/core/narration/speech-script.ts';
import { htmlEmphasis } from '../src/core/narration/text.ts';

const root = path.resolve(import.meta.dirname, '..');

function script(html: string) {
  const blocks = htmlToBlocks(html);
  return speechScript(blocks, { emphasis: htmlEmphasis(html) });
}

const texts = (html: string): string[] => script(html).items.map((i) => i.text);
const moods = (html: string): string[] => script(html).items.map((i) => i.mood ?? 'calm');
const said = (it: SpeechItem | undefined): string => it?.delivery?.say ?? it?.text ?? '';

describe('feeding Nano (test A: whole sentences, then breath groups)', () => {
  it('keeps abbreviations, initials and decimals inside one sentence', () => {
    expect(texts('<p>Mr. Holmes met Dr. Watson at 5 p.m. in St. James Street. J. K. Smith was already there.</p>')).toEqual([
      'Mister Holmes met Doctor Watson at 5 p.m. in Saint James Street.',
      'J. K. Smith was already there.',
    ]);
  });

  it('keeps a quotation with its tag and splits after a closing quote', () => {
    expect(texts('<p>“I wish I hadn’t cried so much!” said Alice, as she swam about. “I shall be punished for it now, I suppose.”</p>')).toEqual([
      '"I wish I hadn\'t cried so much!" said Alice, as she swam about.',
      '"I shall be punished for it now, I suppose."',
    ]);
  });

  it('does not split at an ellipsis before a lowercase word, only before a new sentence', () => {
    expect(texts('<p>“I… I don’t know what you mean,” he said. Then… nothing at all. The room was silent again.</p>')).toEqual([
      '"I… I don\'t know what you mean," he said.',
      'Then… nothing at all.',
      'The room was silent again.',
    ]);
  });

  it("gives Nano the whole sentence (the phrase list is only for Kokoro's phrase breaks)", () => {
    const it0 = script('<p>The rain had stopped by the time we reached the old bridge, and for a moment the whole city held its breath.</p>').items[0];
    expect(it0?.phrases?.length).toBe(2);
    expect(said(it0)).toBe('The rain had stopped by the time we reached the old bridge, and for a moment the whole city held its breath.');
  });

  it('groups a paragraph into breath-group chunks under the character limit; titles and system lines stand alone', () => {
    const s = script(
      '<p>Chapter 3</p><p>The rain had stopped by the time we reached the old bridge. A bell rang. Nobody spoke for a long time after that.</p><p>[Skill acquired]</p><p>She smiled.</p>',
    );
    const chunk = s.items.map((i) => i.chunk);
    expect(chunk[0]).toBe(0); // the title
    const para = s.items.filter((i) => i.block === 1).map((i) => i.chunk);
    expect(new Set(para).size).toBeLessThanOrEqual(2);
    for (const id of new Set(chunk)) {
      const members = s.items.filter((i) => i.chunk === id);
      const chars = members.reduce((n, i) => n + said(i).length + 1, -1);
      expect(chars <= CHUNK_MAX_CHARS || members.length === 1).toBe(true);
    }
    const sys = s.items.find((i) => i.kind === 'system');
    expect(s.items.filter((i) => i.chunk === sys?.chunk)).toHaveLength(1);
    for (let k = 1; k < chunk.length; k++) expect((chunk[k] ?? 0) - (chunk[k - 1] ?? 0)).toBeGreaterThanOrEqual(0);
  });

  it('joins a quote paragraph that continues the same speaker to the one before', () => {
    const s = script('<p>“I went to the river. I waited there all night,</p><p>“and nobody came.”</p><p>She nodded.</p>');
    expect(s.items.map((i) => i.chunk)).toEqual([0, 0, 0, 1]);
    const line = { block: 0, kind: 'text' as const, chars: 40, startsSpoken: false, quoteOpen: false };
    expect(planChunks([{ ...line, t: 0.7 }, { ...line, t: 0.9 }])).toEqual([0, 1]);
    expect(planChunks([{ ...line, t: 0.7 }, { ...line, t: 0.75 }])).toEqual([0, 0]);
  });

  it('ships the mood table and the audio tunables once per script', () => {
    const s = script('<p>One. Two three four five six.</p>');
    expect(s.delivery?.moods).toBe(MOOD_TABLE);
    expect(s.delivery?.audio.breathDb).toBe(-22);
    expect(DELIVERY_AUDIO.speechRmsDb).toBe(-20);
    expect(DELIVERY_AUDIO.rateCap).toBeLessThanOrEqual(0.1);
  });

  it('never changes the displayed text or its offsets, only what Nano reads', () => {
    const html = '<p>“Kneel,” she ordered. “You are <em>mine</em> now!”</p><p>BOOM!</p>';
    const blocks = htmlToBlocks(html);
    const plain = speechScript(blocks);
    const directed = speechScript(blocks, { emphasis: htmlEmphasis(html) });
    expect(directed.items.map((i) => [i.block, i.start, i.end, i.hash, i.text])).toEqual(plain.items.map((i) => [i.block, i.start, i.end, i.hash, i.text]));
  });

  it('describes the text Nano reads: syllables, dramatic ellipses and punctuation inside the sentence', () => {
    expect(syllables('The rain had stopped by the time we reached the old bridge.')).toBe(12);
    expect(syllables('[chuckle] Fine.')).toBe(1);
    const shape = speechShape('You are cute when you are… flustered, she said.');
    expect(shape.syl).toBe(10);
    expect(shape.ell).toHaveLength(1);
    expect(shape.pun).toHaveLength(2);
    expect(shape.ell?.[0]).toBeCloseTo(20 / 36, 2);
    expect(speechShape('Wait…')).toEqual({ syl: 1 }); // a trailing "…" is not inside the sentence
  });
});

describe('single quotation marks', () => {
  it('are thoughts in a chapter that quotes speech with double marks; apostrophes never count', () => {
    const s = script(`<p>“Such a fool…” the sword sighed.</p><p>'What was I thinking about?'</p><p>Sunny’s blade didn’t stop.</p><p>‘I don’t get it… damn!’</p>`);
    const byText = (t: string) => s.items.find((i) => i.text.includes(t));
    expect(byText('thinking')?.thought).toBe(true);
    expect(byText('thinking')?.role).toBe('dialogue');
    expect(byText('get it')?.thought).toBe(true);
    expect(byText('blade')?.role).toBeUndefined();
  });

  it('are speech in a chapter without double marks (British style)', () => {
    const s = script(`<p>‘Run, now. Go!’ she said.</p><p>‘I won’t.’</p><p>The boys’ room was empty.</p>`);
    expect(s.items.find((i) => i.text.includes('Run'))?.role).toBe('dialogue');
    const now = s.items.find((i) => i.text.includes('won'));
    expect(now?.role).toBe('dialogue');
    expect(now?.thought).toBeUndefined();
    expect(s.items.find((i) => i.text.includes('room'))?.role).toBeUndefined();
  });

  it('mark dialogue and thoughts as performed, a thought a little quieter, and never share a call with narration', () => {
    const s = script(`<p>“Run now, go!” she said.</p><p>He ran.</p><p>'I knew it.'</p>`);
    const [run, ran, knew] = ['Run', 'ran', 'knew'].map((t) => s.items.find((i) => i.text.includes(t)));
    expect(run?.voice).toBe('performed');
    expect(ran?.voice).toBeUndefined();
    expect(knew?.voice).toBe('performed');
    expect(run?.chunk).not.toBe(ran?.chunk);
    expect(knew?.delivery?.g ?? 0).toBeLessThan(0);
  });

  it('carry a thought into the next paragraph only when that one closes it', () => {
    const s = script(`<p>“Hm.”</p><p>'The shell protects me.</p><p>But the others… I don't know.'</p><p>He shook his head.</p>`);
    expect([...new Set(s.items.filter((i) => i.thought).map((i) => i.block))]).toEqual([1, 2]);
    expect(s.items.find((i) => i.text.includes('shook'))?.thought).toBeUndefined();
  });
});

describe('the director: moods (test B)', () => {
  it('reads dialogue tags: whispered, snapped, laughed, sighed', () => {
    const s = script(
      [
        '<p>“Come closer,” she whispered.</p>',
        '<p>The lamp flickered on the desk between them, and the rain kept falling.</p>',
        '<p>“That lantern is not yours to sell!” he snapped.</p>',
        '<p>Outside, the carts rolled past the window one after another.</p>',
        '<p>“The whole thing was a disaster,” she laughed.</p>',
        '<p>The clock on the wall ticked on, slow and patient as ever.</p>',
        '<p>“I suppose you are right,” she sighed.</p>',
      ].join(''),
    );
    expect(s.items.map((i) => i.mood ?? 'calm')).toEqual(['whisper', 'calm', 'intense', 'calm', 'playful', 'calm', 'sad']);
    expect(s.items[0]?.delivery?.t).toBe(MOOD_TABLE.whisper.t);
    expect(s.items[0]?.delivery?.g).toBeLessThan(0);
  });

  it('applies a tag that follows the words to the whole quotation in that paragraph', () => {
    expect(moods('<p>“Don’t move. They can hear us,” she whispered.</p>')).toEqual(['whisper', 'whisper']);
    expect(moods('<p>Mara laughed. “The whole thing was a disaster.”</p>').slice(1)).toEqual(['playful']);
  });

  it('uses punctuation when there is no tag: "!" intense, a trailing "…" soft, "?" calm', () => {
    expect(moods('<p>“The whole bridge is coming down!”</p><p>“I only wanted to help…”</p><p>“Where did the lantern go?”</p>')).toEqual([
      'intense',
      'soft',
      'calm',
    ]);
  });

  it('keeps narration steady and dialogue a little more animated (same voice)', () => {
    const [n, d] = script('<p>The cart rolled slowly into the empty market square.</p><p>“The cart is finally here, everyone.”</p>').items;
    expect(n?.delivery).toMatchObject({ t: MOOD_TABLE.calm.t, g: 0, s: 1 });
    expect(d?.delivery).toMatchObject({ t: MOOD_TABLE.calm.t + DIALOGUE_LIFT_T, g: CLASS_TABLE.dialogue.g, s: 1 });
    expect(n?.delivery?.c).toBeUndefined();
  });

  it('gives LitRPG system messages a crisp, slightly faster, even read', () => {
    const s = script('<p>The goblin fell.</p><p>[You have gained a level!]</p><p>[Strength +2]</p>');
    const sys = s.items.filter((i) => i.kind === 'system');
    expect(sys.length).toBeGreaterThan(0);
    for (const it of sys) {
      expect(it.mood).toBe('system');
      expect(it.delivery).toMatchObject({ t: MOOD_TABLE.system.t, g: 0, s: MOOD_TABLE.system.s });
      expect(it.naturalMs).toBeUndefined(); // even pauses: no variation
    }
    expect(segmentKind('system')).toBe('system');
    expect(segmentKind('text')).toBe('normal');
  });
});

describe('the director: line classes (the narrator persona)', () => {
  it('teasing: teased/smirked/purred/hummed, "Hmm", "Oh", a drawl — playful, lower by varispeed', () => {
    const s = script(
      [
        '<p>“Is that all you can do?” she teased.</p>',
        '<p>The fire crackled in the hearth while the wind howled outside.</p>',
        '<p>“Hmm, you look nervous tonight.”</p>',
        '<p>He looked away from her and studied the old map on the table.</p>',
        '<p>“Oh, you think you can hide from me?”</p>',
        '<p>The candles burned low as the hours slipped away from them both.</p>',
        '<p>“You are cute when you are… flustered.”</p>',
      ].join(''),
    );
    expect(s.items.map((i) => i.line ?? null)).toEqual(['teasing', null, 'teasing', null, 'teasing', null, 'teasing']);
    expect(s.items[0]?.mood).toBe('playful');
    expect(s.items[0]?.delivery).toMatchObject({ t: 0.85, c: CLASS_TABLE.teasing.cents });
  });

  it('a sad line is never teasing, whatever its opener', () => {
    expect(script('<p>“Hmm, not again,” she sighed.</p>').items[0]?.line).toBeUndefined();
  });

  it('non-verbals: from the attribution, teasing chuckle/"hm" in turn, sparingly, never the same twice in a row', () => {
    const html = Array.from({ length: 20 }, (_, k) => `<p>“Try again, little one, attempt number ${k + 1} of many?” she teased.</p>`).join('');
    const nvs = script(html).items.map((i) => i.delivery?.nv ?? null);
    const at = nvs.flatMap((t, k) => (t ? [k] : []));
    expect(at.length).toBeGreaterThanOrEqual(2);
    for (let k = 1; k < at.length; k++) {
      expect((at[k] ?? 0) - (at[k - 1] ?? 0)).toBeGreaterThanOrEqual(Math.max(TEASING_CHUCKLE_EVERY, MIN_TAG_GAP));
      expect(nvs[at[k] ?? 0]).not.toBe(nvs[at[k - 1] ?? 0]);
    }
    const laugh = script('<p>“The whole thing was a disaster,” she laughed.</p>').items[0]?.delivery;
    expect(laugh?.nv).toBe('laugh');
    expect(laugh?.say ?? '').not.toMatch(/\[/); // never a Nano tag
    expect(script('<p>“Hmm, the whole thing was a disaster,” she laughed.</p>').items[0]?.delivery?.nv).toBeUndefined(); // already says it
    expect([...NON_VERBALS]).toEqual(['chuckle', 'laugh', 'hm', 'mm']);
  });

  it('commanding: imperatives, "ordered", a short "Now." — falling ending, lower, softer', () => {
    const s = script('<p>“Kneel!” she ordered.</p><p>The hall went silent around them.</p><p>“Come here and look at me!”</p><p>“Now.”</p>');
    const [kneel, , come, now] = s.items;
    expect([kneel?.line, come?.line, now?.line]).toEqual(['commanding', 'commanding', 'commanding']);
    expect(said(kneel)).toBe('"Kneel." she ordered.');
    expect(said(come)).toBe('"Come here, and look at me."');
    expect(come?.mood ?? 'calm').toBe('calm'); // never shouted, whatever the "!"
    expect(come?.delivery).toMatchObject({ c: CLASS_TABLE.commanding.cents, g: CLASS_TABLE.commanding.g });
  });

  it('tender: endearments and comfort', () => {
    const s = script('<p>“It’s okay, I’m here with you now, sweetheart.”</p><p>“Rest a little while longer,” she said gently.</p>');
    expect(s.items.map((i) => i.line)).toEqual(['tender', 'tender']);
    expect(s.items[0]?.mood).toBe('soft');
  });

  it('pauses before the key word: the italic word, else the last content word, not as a tic', () => {
    const s = script(
      '<p>“You are cute when you are flustered,” she teased.</p><p>The candle guttered.</p><p>The night went on.</p><p>“Then you <em>knew</em> about the river all along.”</p>',
    );
    expect(said(s.items[0])).toBe('"You are cute when you are… flustered," she teased.');
    expect(said(s.items[3])).toBe('"Then you… knew about the river all along."');
    expect(lastContentWord('Come here to me now.')).toBe('now');
    expect(lastContentWord('Is that all you can do?')).toBeUndefined();
    // Two words before the key word at least ("I… told you" would sound broken).
    expect(nanoText('"I told you."', { dialogue: true, stress: 'word', keyWord: 'told' })).toBe('"I told you."');
  });
});

describe('the director: emphasis', () => {
  it('stresses italics and bold; a whole italic sentence is a thought', () => {
    const s = script('<p>She had <em>told</em> him twice already.</p><p><i>This is a terrible idea, and I am going anyway.</i></p><p>The door was <b>locked</b>.</p>');
    expect(s.items.map((i) => [i.mood ?? 'calm', i.delivery?.g])).toEqual([
      ['calm', 0.4],
      ['soft', -1],
      ['calm', 0.4],
    ]);
  });

  it('reads ALL CAPS words as stress, never shouted or spelled; a sound effect gets a short pause first', () => {
    const s = script('<p>He was HUGE, bigger than the gate itself.</p><p>BOOM!</p><p>Crack—</p><p>“STOP right there,” the guard said.</p>');
    const [huge, boom, crack, stop] = s.items;
    expect(huge?.delivery?.g).toBe(0.4);
    expect(boom?.delivery?.pre).toBe(150);
    expect(said(boom)).toBe('Boom!');
    expect(crack?.delivery?.pre).toBe(150);
    expect(said(crack)).toBe('Crack!');
    expect(stop?.delivery?.pre).toBeUndefined(); // dialogue: a stressed word, not a sound effect
    for (const it of s.items) expect(it.delivery?.g ?? 0).toBeLessThanOrEqual(GAIN_RANGE_DB[1]);
  });

  it('matches fragments in order and on word boundaries', () => {
    const displays = ['He was there.', 'She was not there.', 'The bell was ringing.'];
    expect(alignEmphasis(displays, [{ text: 'not' }, { text: 'was' }]).map((m) => m?.stress)).toEqual([undefined, 'word', undefined]);
    expect(alignEmphasis(['The theme returned.'], [{ text: 'he' }])).toEqual([undefined]);
  });

  it('splits an italic fragment that spans sentences; long bold is styling', () => {
    expect(alignEmphasis(['Run.', 'Do not look back at the city.'], [{ text: 'Run. Do not look back at the city.' }]).map((m) => m?.stress)).toEqual(['thought', 'thought']);
    const long = 'word '.repeat(40).trim();
    expect(alignEmphasis([long], [{ text: long, bold: true }])).toEqual([undefined]);
  });

  it('extracts the outermost <em>/<i>/<strong>/<b> from chapter HTML', () => {
    expect(htmlEmphasis('<p>a <em>very <b>bold</b> idea</em> and <strong>more</strong><script><i>no</i></script></p>')).toEqual([
      { text: 'very bold idea' },
      { text: 'more', bold: true },
    ]);
  });
});

describe('the director: scene mood', () => {
  it('carries the scene mood (no flip-flopping) and resets it at a scene break and a POV header', () => {
    const tense =
      '<p>Blood dripped from the broken gate onto the stones.</p><p>Something screamed in the dark beyond the wall.</p><p>He kept walking toward the stairs.</p><p>The torches froze in mid-flicker as the wind died.</p><p>Fresh blood ran between the stones.</p>';
    const m = moods(`${tense}<hr><p>The morning was quiet and bright.</p><p>Birds sang along the river bank.</p>`);
    expect(m.slice(0, 5)).toEqual(['tense', 'tense', 'tense', 'tense', 'tense']);
    expect(m.slice(-2)).toEqual(['calm', 'calm']);
    expect(moods(`${tense}<p>— Nephis —</p><p>The garden was calm.</p><p>She read until noon.</p>`).slice(-2)).toEqual(['calm', 'calm']);
  });

  it('a dialogue tag always wins over the scene', () => {
    const list: DirectorSentence[] = [0, 1, 2, 3, 4].map((b) => ({ block: b, kind: 'text', display: 'Blood dripped from the gate.', narration: 'Blood dripped from the gate.', dialogueShare: 0 }));
    list[2] = { block: 2, kind: 'text', display: '“Quiet,” she whispered.', narration: 'she whispered.', speech: 'Quiet,', dialogueShare: 0.5 };
    expect(direct(list).map((c) => c.mood)).toEqual(['tense', 'tense', 'whisper', 'tense', 'tense']);
  });

  it('smooths isolated labels with a window, and narration stays toned down', () => {
    const cue = (mood: Cue['mood'], dialogue = false): Cue => ({ mood, dialogue });
    const list = Array.from({ length: 5 }, () => ({ kind: 'text' as const }));
    expect(smoothScenes([cue('calm'), cue('calm'), cue('intense'), cue('calm'), cue('calm')], list).map((c) => c.mood)).toEqual(['calm', 'calm', 'calm', 'calm', 'calm']);
    const run = [cue('intense', true), cue('intense', true), cue('calm'), cue('intense', true), cue('intense', true)];
    expect(smoothScenes(run, list)[2]?.mood).toBe('tense');
  });
});

describe('Nano parameters', () => {
  it('stay inside the approved ranges for every mood, class, stress and dialogue combination', () => {
    for (const mood of MOODS) {
      for (const line of LINE_CLASSES) {
        for (const dialogue of [false, true]) {
          for (const stress of [undefined, 'word', 'thought', 'sfx'] as const) {
            const p = deliveryParams({ mood, dialogue, line, ...(stress ? { stress } : {}) });
            expect(p.t).toBeGreaterThanOrEqual(TEMPERATURE_RANGE[0]);
            expect(p.t).toBeLessThanOrEqual(TEMPERATURE_RANGE[1]);
            expect(Math.abs(p.g)).toBeLessThanOrEqual(GAIN_RANGE_DB[1]);
            // The time-stretch part never goes past ±4 %; varispeed (cents) carries the classes.
            expect(p.s).toBeGreaterThanOrEqual(TEMPO_LIMITS[0]);
            expect(p.s).toBeLessThanOrEqual(TEMPO_LIMITS[1]);
            expect(Math.abs(p.c ?? 0)).toBeLessThanOrEqual(CENTS_RANGE[1]);
            if (line === 'narration' || line === 'dialogue' || mood === 'system') expect(p.c).toBeUndefined();
          }
        }
      }
    }
  });

  it('maps calm to 0.70 and teasing/playful to 0.85 (approved test B); commands are lower and softer', () => {
    expect(deliveryParams({ mood: 'calm', dialogue: false })).toEqual({ t: 0.7, g: 0, s: 1 });
    expect(deliveryParams({ mood: 'playful', dialogue: true }).t).toBe(0.85);
    expect(deliveryParams({ mood: 'intense', dialogue: true }).g).toBe(1.2);
    expect(deliveryParams({ mood: 'calm', dialogue: true, line: 'commanding' })).toMatchObject({ g: -1, c: -60, s: 1 });
    expect(deliveryParams({ mood: 'playful', dialogue: true, line: 'teasing', nv: 'chuckle' })).toMatchObject({ c: -40, nv: 'chuckle' });
  });

  it('reshapes leftover capitals, never writes a tag', () => {
    expect(nanoText('BAM! The door flew open.', { stress: 'sfx', dialogue: false })).toBe('Bam! The door flew open.');
    expect(nanoText('He hit the HP potion.', { dialogue: false })).toBe('He hit the HP potion.');
  });
});

describe('pauses: the context model', () => {
  const side = (o: Partial<PauseSide>): PauseSide => ({ block: 0, kind: 'text', startsSpoken: false, endsSpoken: false, quoteOpen: false, ...o });

  it('names what each boundary hands over to', () => {
    expect(pauseContext(side({}), side({}))).toBe('narration');
    expect(pauseContext(side({}), side({ block: 1 }))).toBe('paragraph');
    expect(pauseContext(side({}), side({}), true)).toBe('paragraph');
    expect(pauseContext(side({ endsSpoken: true }), side({ startsSpoken: true }))).toBe('sameSpeaker');
    expect(pauseContext(side({ endsSpoken: true, quoteOpen: true }), side({ block: 1, startsSpoken: true }))).toBe('sameSpeaker');
    expect(pauseContext(side({ endsSpoken: true }), side({ block: 1, startsSpoken: true }))).toBe('exchange');
    expect(pauseContext(side({}), side({ startsSpoken: true }))).toBe('switch');
    expect(pauseContext(side({ endsSpoken: true }), side({ block: 1 }))).toBe('switch');
    expect(pauseContext(side({ command: true, endsSpoken: true }), side({}))).toBe('command');
    expect(pauseContext(side({}), undefined)).toBeUndefined();
    expect(pauseContext(side({}), side({ kind: 'system' }))).toBeUndefined();
  });

  it('lands inside each context range (±10 %), deterministic for a seed', () => {
    const base = { kind: 'text' as const, display: 'The rain fell.', pauseMs: 320, relaxedMs: 400, sameParagraphNext: true };
    for (const [context, [lo, hi]] of Object.entries(PAUSE_MODEL) as [keyof typeof PAUSE_MODEL, readonly [number, number]][]) {
      const mid = (lo + hi) / 2;
      for (let seed = 0; seed < 200; seed++) {
        const ms = naturalPause({ ...base, context, seed });
        expect(ms).toBeGreaterThanOrEqual(Math.floor(mid * (1 - PAUSE_JITTER)));
        expect(ms).toBeLessThanOrEqual(Math.ceil(mid * (1 + PAUSE_JITTER)));
      }
    }
    expect(naturalPause({ ...base, context: 'narration', seed: 42 })).toBe(naturalPause({ ...base, context: 'narration', seed: 42 }));
    expect(pauseSeed(123, 4)).not.toBe(pauseSeed(123, 5));
    expect(PAUSE_JITTER).toBe(0.1);
  });

  it('×1.2 after "…" inside a paragraph, ×0.85 after an intense line; titles and system lines keep theirs', () => {
    const base = { kind: 'text' as const, display: 'And then…', pauseMs: 320, relaxedMs: 400, sameParagraphNext: true, context: 'narration' as const };
    expect(naturalPause({ ...base, seed: 7 })).toBe(Math.round(525 * ELLIPSIS_PAUSE * pauseJitter(7)));
    expect(naturalPause({ ...base, display: 'And then.', intense: true, seed: 7 })).toBe(Math.round(525 * INTENSE_PAUSE * pauseJitter(7)));
    expect(naturalPause({ ...base, kind: 'title', pauseMs: 1300, relaxedMs: 1300, seed: 1 })).toBe(1300);
    expect(naturalPause({ ...base, kind: 'system', pauseMs: 950, relaxedMs: 950, seed: 1 })).toBe(950);
  });

  it('in a chapter: a one-word command, a new paragraph of narration, narration → dialogue', () => {
    const s = script('<p>“Kneel!” she ordered.</p><p>The hall went silent around them for a long while.</p><p>The torches burned low.</p><p>“Good.”</p>');
    const [kneel, hall, torches] = s.items;
    expect(kneel?.naturalMs).toBeGreaterThanOrEqual(450);
    expect(kneel?.naturalMs).toBeLessThanOrEqual(550);
    expect(hall?.naturalMs).toBeGreaterThanOrEqual(Math.floor(925 * 0.9));
    expect(torches?.naturalMs).toBeGreaterThanOrEqual(Math.floor(650 * 0.9));
    expect(torches?.naturalMs).toBeLessThanOrEqual(Math.ceil(650 * 1.1));
  });

  it('vary evenly both ways', () => {
    let shorter = 0;
    for (let seed = 0; seed < 4000; seed++) if (pauseJitter(seed) < 1) shorter++;
    expect(shorter).toBeGreaterThan(1800);
    expect(shorter).toBeLessThan(2200);
    for (let seed = 0; seed < 500; seed++) expect(Math.abs(pauseJitter(seed, 0.9) - 1)).toBeLessThanOrEqual(0.3 + 1e-9);
  });
});

describe('breath points (native fits a breath in the pause or skips it, never adds time)', () => {
  const at = (html: string): (string | null)[] => script(html).items.map((i) => i.breath ?? null);

  it('before a new paragraph and after a long sentence-final pause, never at the end', () => {
    expect(at('<p>The rain had stopped by the time we reached the old bridge.</p><p>Somewhere far behind us a bell rang three times, slow and heavy.</p>')).toEqual(['paragraph', null]);
    expect(breathPoint({ block: 0, kind: 'text', speaks: false }, { block: 0, kind: 'text', speaks: false, continuesQuote: false }, 450)).toBe('sentence');
    expect(breathPoint({ block: 0, kind: 'text', speaks: false }, { block: 0, kind: 'text', speaks: false, continuesQuote: false }, 300)).toBeUndefined();
  });

  it('never in a back-and-forth of dialogue, never inside a quotation that goes on', () => {
    expect(at('<p>“Where were you all night?”</p><p>“At the old bridge, waiting for you.”</p><p>The rain kept falling on the stones.</p>')).toEqual([null, 'paragraph', null]);
    expect(breathPoint({ block: 0, kind: 'text', speaks: true }, { block: 0, kind: 'text', speaks: true, continuesQuote: true }, 900)).toBeUndefined();
    expect(script('<p>“Don’t move. They can hear us, and they are close,” she whispered. The torches went out.</p>').items[0]?.breath).toBeUndefined();
  });

  it('ships the lung budget and placement window to native', () => {
    expect(DELIVERY_AUDIO.breathEverySec).toEqual([6, 8]);
    expect(DELIVERY_AUDIO.breathParagraphSec).toBe(4);
    expect(DELIVERY_AUDIO.breathStartMs).toEqual([120, 200]);
    expect(DELIVERY_AUDIO.breathEndMs).toEqual([80, 150]);
    expect(DELIVERY_AUDIO.breathSource).toBe('procedural');
  });
});

describe('Voice Lab lines', () => {
  it('lets hand annotations win and never writes a tag', () => {
    const out = deliverLines([
      { text: '“It was a fair price, I swear [chuckle]. Well, almost fair.”', emotion: 'happy' },
      { text: '“That compass was the only thing he left me.”', emotion: 'sad', style: 'whisper' },
      { text: 'Tobin raised both hands and tried to smile.' },
    ]);
    expect(out.map((o) => o.mood)).toEqual(['playful', 'whisper', 'calm']);
    expect(out[1]?.delivery.g).toBeLessThan(0);
    for (const o of out) expect(o.pauseMs).toBeGreaterThan(300);
  });

  it('splits quotes from narration', () => {
    expect(quoteSplit('“Run,” she said.')).toEqual({ narration: 'she said.', speech: 'Run,', dialogueShare: 3 / 10 });
  });
});

describe('budget and contract', () => {
  it('directs a long chapter well under 5 ms per sentence', () => {
    const para = '<p>“Hold the line!” he shouted, and the soldiers braced behind their shields. <em>Not yet</em>, she thought… The gate shuddered.</p>';
    const html = para.repeat(300);
    const t0 = performance.now();
    const s = script(html);
    const ms = (performance.now() - t0) / s.items.length;
    expect(s.items.length).toBeGreaterThan(800);
    expect(ms).toBeLessThan(1); // the whole script (front-end included), let alone the director
  });

  it('native knows every mood and non-verbal (HDVoiceCore Delivery.swift)', () => {
    const swift = readFileSync(path.join(root, 'ios/App/HDVoice/Sources/HDVoiceCore/Delivery.swift'), 'utf8');
    const cases = /enum DeliveryMood[^{]*\{([\s\S]*?)\n\}/.exec(swift)?.[1] ?? '';
    for (const m of MOODS) expect(cases).toContain(`case ${m}`);
    const nv = /enum NonVerbalType[^{]*\{([\s\S]*?)\n\}/.exec(swift)?.[1] ?? '';
    for (const t of NON_VERBALS) expect(nv).toContain(`case ${t}`);
  });
});
