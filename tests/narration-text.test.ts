/**
 * Narration text prep (src/core/narration/prep): normalization rules (each rule's own examples), skipping
 * (and never dropping story text), LitRPG system messages and stat tables, the pronunciation dictionary,
 * source offsets, speed. Fixtures are short synthetic snippets in the style of LitRPG / translated web
 * novels (no copyrighted text).
 */
import { buildScript, htmlToBlocks, segmentHash, type Lexicon, type SourceBlock } from '@v1tts/frontend.ts';
import { describe, expect, it } from 'vitest';
import { cleanupPlan, isAntiTheft, isNavigation, isPlug, isSeparator } from '../src/core/narration/prep/cleanup.ts';
import { applyLexicon, compileLexicons, possessivePhonemes, sayText } from '../src/core/narration/prep/lexicon.ts';
import { POST_RULES, PRE_RULES, normalizeSpeech } from '../src/core/narration/prep/normalize.ts';
import { cardinalWords, moneyWords, timeWords, yearWords } from '../src/core/narration/prep/numbers.ts';
import { normalizeTextPrep } from '../src/core/narration/prep/prefs.ts';
import { prepareScript } from '../src/core/narration/prep/prepare.ts';
import { findStatTables, isBracketedNotice, isSystemBlock, parseStatLine } from '../src/core/narration/prep/system.ts';
import { narrationSegments } from '../src/core/narration/segment.ts';
import { speechScript, type SpeechItem, type SpeechScriptOptions } from '../src/core/narration/speech-script.ts';

const items = (html: string, opts: SpeechScriptOptions = {}): SpeechItem[] => speechScript(htmlToBlocks(html), opts).items;
const said = (html: string, opts: SpeechScriptOptions = {}): string[] => items(html, opts).map((i) => i.text);
const lex = (...entries: Lexicon['entries']): Lexicon => ({ schemaVersion: 1, entries });

describe('normalization rules (table-driven)', () => {
  for (const rule of [...PRE_RULES, ...POST_RULES]) {
    it(rule.id, () => {
      expect(rule.examples.length).toBeGreaterThan(0);
      for (const [input, output] of rule.examples) expect(normalizeSpeech(input, { system: rule.system === true })).toBe(output);
    });
  }

  it('says numbers like a narrator', () => {
    expect(cardinalWords('1,000')).toBe('one thousand');
    expect(cardinalWords('0042')).toBe('zero zero four two');
    expect(yearWords(1999)).toBe('nineteen ninety-nine');
    expect(yearWords(2005)).toBe('two thousand and five');
    expect(yearWords(1900)).toBe('nineteen hundred');
    expect(moneyWords('$', '0.01')).toBe('one cent');
    expect(timeWords(0, 0)).toBe('midnight');
  });

  it('keeps LitRPG lines sensible', () => {
    expect(normalizeSpeech('He reached Lv. 10 and gained +5 STR, +3 AGI.')).toBe('He reached Level ten and gained plus five Strength, plus three Agility.');
    expect(normalizeSpeech('HP: 50/120, MP 30/30')).toBe('H P: fifty out of one hundred and twenty, M P thirty out of thirty');
    expect(normalizeSpeech('Damage x2 for 10k gold.')).toBe('Damage times two for ten thousand gold.');
    expect(normalizeSpeech('Chapter IV: Rank II')).toBe('Chapter four: Rank two');
    expect(normalizeSpeech('Mr. Lee vs. Dr. Kim on St. Mary St.')).toBe('Mister Lee versus Doctor Kim on Saint Mary Street');
    expect(normalizeSpeech('Wait... no -- stop!!')).toBe('Wait… no — stop!');
    expect(normalizeSpeech('Nice 😂🔥 job ♥')).toBe('Nice job');
  });

  it('never touches the pronoun I or plain words in capitals', () => {
    expect(normalizeSpeech('I said I would, and I did.')).toBe('I said I would, and I did.');
    expect(normalizeSpeech('Henry VIII was king.')).toBe('Henry the eighth was king.');
    expect(normalizeSpeech('He read Part I of the book.')).toBe('He read Part one of the book.');
    expect(normalizeSpeech('THE END')).toBe('THE END');
  });
});

describe('cleanup: what is not read', () => {
  const chapter =
    '<p>Translator: Moonlit Pages | Editor: Sam</p>' +
    '<p>Chapter 12 - Rain</p><p>Chapter 12: Rain</p>' +
    '<p>TL note: qi is life energy.</p>' +
    '<p>He gathered qi [TN: life energy] in his dantian.[1]</p>' +
    '<p>[T/N: The author hiccupped.]</p>' +
    '<p>Previous Chapter | Table of Contents | Next Chapter</p>' +
    '<p>x-x-x</p>' +
    '<p>He stood up. Read the latest chapters at n0velb1n.c0m for free. Then he left.</p>' +
    '<p>She read Royal Road at night.</p>' +
    '<p>Next chapter, she thought, would be easier.</p>' +
    '<p>Author&#39;s Note:</p><p>Thanks for reading! The next chapter comes Friday.</p><p>Join our Discord for early access!</p>';

  it('drops notes, plugs, navigation, anti-theft lines and the repeated title; keeps the story', () => {
    expect(said(chapter)).toEqual([
      'Chapter twelve. Rain.',
      'He gathered chee in his dahn-tyen.',
      'He stood up.',
      'Then he left.',
      'She read Royal Road at night.',
      'Next chapter, she thought, would be easier.',
    ]);
  });

  it('reads decorative separators as a scene-break pause', () => {
    const s = items(chapter);
    expect(s.find((i) => i.text.startsWith('He gathered'))?.pauseMs).toBe(1800);
    expect(said('<p>One.</p><p>oOo</p><p>Two.</p><p>◇◇◇</p><p>Three.</p>')).toEqual(['One.', 'Two.', 'Three.']);
    expect(items('<p>One more.</p><p>oOo</p><p>Two more.</p>')[0]?.pauseMs).toBe(1800);
  });

  it('with "Skip translator & author notes" off, notes are read; navigation and anti-theft lines still go', () => {
    const s = said(chapter, { skipNotes: false });
    expect(s.join(' ')).toContain('is life energy');
    expect(s.filter((t) => t.startsWith('Chapter twelve'))).toHaveLength(1);
    expect(s.join(' ')).toContain('Join our Discord');
    expect(s.join(' ')).not.toMatch(/Previous Chapter|n0velb1n/i);
  });

  it('only takes the note blocks after a heading at the chapter end; mid-chapter just the heading', () => {
    const mid = '<p>Story one goes on here.</p><p>Author&#39;s note</p><p>The wind rose over the hills.</p>' + '<p>More story here.</p>'.repeat(8);
    expect(said(mid)).toContain('The wind rose over the hills.');
    expect(said(mid)).not.toContain("Author's note");
  });

  it('plugs: links anywhere, calls to action only at the start or end, never story mentions', () => {
    expect(isPlug('Read 10 chapters ahead on patreon.com/somebody', false)).toBe(true);
    expect(isPlug('Support me on Patreon to read ahead!', true)).toBe(true);
    expect(isPlug('Support me on Patreon to read ahead!', false)).toBe(false);
    expect(isPlug('She checked her Patreon earnings before bed.', true)).toBe(false);
    expect(isPlug('“Join my Discord,” he said.', true)).toBe(false);
  });

  it('navigation needs nav words in a nav shape', () => {
    for (const t of ['Previous Chapter | Next Chapter', '<< Prev', 'Next Chapter >>', 'Table of Contents', 'Prev | ToC | Next']) expect(isNavigation(t)).toBe(t !== 'Table of Contents' ? true : false);
    for (const t of ['Next!', 'Next chapter, she thought.', 'Chapter 12', 'Previous attempts had failed.']) expect(isNavigation(t)).toBe(false);
  });

  it('anti-theft: a web address (or a reading site) together with a reading/source phrase', () => {
    for (const t of [
      'Read the latest chapters at n0velb1n.c0m',
      'This chapter is from novelfire.net, please read it there.',
      'Find authorized novels in Webnovel, faster updates, better experience.',
      'If you are reading this on any other site, it was stolen from Royal Road.',
      'Visit lightnovel-world dot com for more.',
    ])
      expect(isAntiTheft(t), t).toBe(true);
    for (const t of ['She read Royal Road at night.', 'He bought a new domain, ember.com, for the shop.', 'The original chapter of his life was over.']) expect(isAntiTheft(t), t).toBe(false);
  });

  it('separators: symbols or x/o patterns, not punctuation beats or words', () => {
    for (const t of ['x-x-x', 'oOo', 'O0O'.toLowerCase() === 'o0o' ? 'o0o' : 'o0o', '◇◇◇', '~~~~', '=====', '* * *', '§', '-x-x-']) expect(isSeparator(t), t).toBe(true);
    for (const t of ['……', '?!', 'Ooo, shiny!', 'xXx the Destroyer', 'OK', 'Ooo']) expect(isSeparator(t), t).toBe(false);
  });

  it('keeps the most complete of repeated titles at the top', () => {
    expect(said('<h1>Chapter 3</h1><p>Chapter 3 - The Hall</p><p>The hall was long.</p>')).toEqual(['Chapter three. The Hall.', 'The hall was long.']);
    expect(said('<p>Chapter 3 - The Hall</p><p>Chapter 4 - The Gate</p><p>Go.</p>').slice(0, 2)).toEqual(['Chapter three. The Hall.', 'Chapter four. The Gate.']);
  });

  it('never drops story text (look-alikes of every rule)', () => {
    const story = [
      'Next, he turned to the door.',
      'Previous attempts had failed.',
      'She read the message on her phone twice.',
      'The translator stammered an apology.',
      'Editors hated him, and he knew it.',
      '“Join our guild,” the man said, grinning.',
      'He checked the Discord server his party used.',
      'Ooo, shiny! He grabbed the coin.',
      'Chapter by chapter, the story grew.',
      'Part of me wanted to stay.',
      'The patrons of the tavern cheered.',
      'The original plan was simple: run.',
      'Thank you, she said, for everything.',
      'He typed www into the bar and stopped.',
      'Author of the letter: unknown, the clerk said.',
      'Table for two, please.',
      'The next chapter of his life began in the north.',
      'The TNT exploded [twice] behind them.',
    ];
    const html = story.map((t) => `<p>${t}</p>`).join('');
    const blocks = htmlToBlocks(html);
    const s = speechScript(blocks).items;
    for (let b = 0; b < blocks.length; b++) expect(s.some((i) => i.block === b), story[b]).toBe(true);
    expect(cleanupPlan(blocks).every((p) => !p.skip && !p.drops)).toBe(true);
  });
});

describe('LitRPG system messages', () => {
  it('tags notices, notifications and status lines as system, with room around them', () => {
    const s = items(
      '<p>The air shimmered.</p><p>[Skill acquired: Shadow Step (Rank II)]</p><p>Ding!</p><p>You have gained 50 EXP.</p><p>【Level Up!】<br>Strength +1<br>Agility +1</p><p>&lt;Quest Complete&gt;</p><p>He nodded.</p>',
    );
    expect(s.map((i) => i.kind)).toEqual(['text', 'system', 'system', 'system', 'system', 'system', 'system', 'system', 'text']);
    expect(s.slice(4, 7).map((i) => i.text)).toEqual(['Level Up!', 'Strength plus one', 'Agility plus one']);
    expect(s[0]?.pauseMs).toBe(950);
    expect(s[1]?.text).toBe('Skill acquired: Shadow Step (Rank two)');
    expect(s[3]?.text).toBe('You have gained fifty E X P.');
    expect(s.at(-2)?.pauseMs).toBe(950);
  });

  it('look-alikes stay story: speech in brackets, quoted brackets, a skill named in a sentence', () => {
    const s = items(
      '<p>&lt;Where are you?&gt;</p><p>[Hey, wait up!]</p><p>“[Status],” he said.</p><p>He checked the [Shadow Step] skill again.</p><p>[I&#39;m coming,] she sent through the bond.</p>',
    );
    expect(s.map((i) => i.kind)).toEqual(['text', 'text', 'text', 'text', 'text']);
    for (const t of ['<Where are you?>', '[Hey, wait up!]', '[I’m coming]', '[Please, no]']) expect(isBracketedNotice(t), t).toBe(false);
    for (const t of ['[Shadow Step]', '[Status]', '<Quest Complete>', '[Warning! A powerful enemy approaches.]', '[You have slain a Goblin.]', '【Title acquired: Slayer】']) expect(isBracketedNotice(t), t).toBe(true);
    expect(isSystemBlock('*Ding*')).toBe(true);
    expect(isSystemBlock('Strength: 12')).toBe(false);
  });
});

describe('stat tables', () => {
  const table = '<p>He opened the window.</p><p>Name: Sunny<br>Level: 5<br>Class: Shadow<br>STR: 12<br>AGI: 9<br>INT: 7<br>HP: 120/120<br>Free points: 3</p><p>He closed it.</p>';

  it('short (default): one compact summary in a sensible order, on the table', () => {
    const s = items(table);
    expect(s.map((i) => i.text)).toEqual([
      'He opened the window.',
      'Status. Name: Sunny, Level five, Class: Shadow, Strength twelve, Agility nine, Intelligence seven, and two more.',
      'He closed it.',
    ]);
    const blocks = htmlToBlocks(table);
    expect(s[1]).toMatchObject({ kind: 'system', block: 1, start: 0, end: blocks[1]?.text.length });
  });

  it('full: every line, compactly ("Strength twelve"), close together', () => {
    const s = items(table, { statTables: 'full' });
    expect(s.slice(1, -1).map((i) => i.text)).toEqual([
      'Name: Sunny',
      'Level five',
      'Class: Shadow',
      'Strength twelve',
      'Agility nine',
      'Intelligence seven',
      'H P one hundred and twenty out of one hundred and twenty',
      'Free points three',
    ]);
    expect(s.slice(1, -2).every((i) => i.pauseMs === 280 && i.kind === 'system')).toBe(true);
    expect(s.at(-2)?.pauseMs).toBe(950);
  });

  it('skip: nothing of it is read', () => {
    expect(said(table, { statTables: 'skip' })).toEqual(['He opened the window.', 'He closed it.']);
  });

  it('one line per block, under a heading', () => {
    const html = '<p>He looked.</p><p>[Status]</p><p>Name: Sunny</p><p>Level: 5</p><p>STR: 12</p><p>AGI: 9</p><p>He closed it.</p>';
    expect(said(html)).toEqual(['He looked.', 'Status. Name: Sunny, Level five, Strength twelve, Agility nine.', 'He closed it.']);
    const tables = findStatTables(htmlToBlocks(html), htmlToBlocks(html).map(() => ({})));
    expect(tables[0]?.blocks).toEqual([1, 2, 3, 4, 5]);
  });

  it('two "Key: value" lines in a story are not a table; neither is speech', () => {
    expect(said('<p>Location: the old mill.</p><p>Time: dusk.</p><p>He waited.</p>')).toEqual(['Location: the old mill.', 'Time: dusk.', 'He waited.']);
    expect(parseStatLine('He said: run')).toBeNull();
    expect(parseStatLine('“Name: Sunny,” he said.')).toBeNull();
    expect(parseStatLine('STR 12')).toEqual({ key: 'STR', value: '12' });
    expect(parseStatLine('[Strength: 12 (+2)]')).toEqual({ key: 'Strength', value: '12 (+2)' });
  });
});

describe('pronunciation dictionary', () => {
  it('whole words only, possessives included (respelling and Kokoro phonemes)', () => {
    const c = compileLexicons([lex({ match: 'Nephis', say: 'NEF-iss', ipa: 'nˈɛfɪs' })]);
    expect(applyLexicon("Nephis's blade. Nephisian? NEPHIS!", c)).toEqual([
      { text: "Nephis's", say: "nef-iss's", ipa: 'nˈɛfɪsɪz' },
      { text: ' blade. Nephisian? ' },
      { text: 'NEPHIS', say: 'nef-iss', ipa: 'nˈɛfɪs' },
      { text: '!' },
    ]);
    expect(possessivePhonemes('sˈʌni')).toBe('z');
    expect(possessivePhonemes('kˈæt')).toBe('s');
  });

  it('case-aware: a name fixes the name, not the word; a lowercase entry matches any case', () => {
    const c = compileLexicons([lex({ match: 'Will', say: 'Wil' }, { match: 'aspirant', say: 'ass-pirant' })]);
    expect(applyLexicon('Will will go.', c).map((p) => p.say ?? p.text).join('')).toBe('Wil will go.');
    expect(applyLexicon('The Aspirant met an aspirant.', c).map((p) => p.say ?? p.text).join('')).toBe('The ass-pirant met an ass-pirant.');
    const exact = compileLexicons([lex({ match: 'SUN', say: 'S U N', caseSensitive: true })]);
    expect(applyLexicon('The sun and the SUN.', exact).map((p) => p.say ?? p.text).join('')).toBe('The sun and the S U N.');
  });

  it('later lists win (built-in < all novels < this novel), longest first, patterns still work', () => {
    const global = lex({ match: 'Star', say: 'starr' }, { match: 'qi', say: 'key' });
    const novel = lex({ match: 'Changing Star', say: 'changing starr two' }, { match: 'qi', say: 'chee-ee' });
    const text = said('<p>Changing Star gathered qi under a Star.</p>', { lexicons: [global, novel] })[0];
    expect(text).toBe('changing starr two gathered chee-ee under a starr.');
    const re = compileLexicons([lex({ match: 'Lord\\s+(?:Shadow|Sun)', say: 'the lord', regex: true })]);
    expect(applyLexicon('Lord  Sun came.', re)[0]).toEqual({ text: 'Lord  Sun', say: 'the lord' });
  });

  it('respellings with stressed capitals are said in lower case; others as typed', () => {
    expect(sayText('NEF-iss')).toBe('nef-iss');
    expect(sayText('ka-SEE-us')).toBe('ka-see-us');
    expect(sayText('Neffis')).toBe('Neffis');
    expect(sayText('lit R P G')).toBe('lit R P G');
  });

  it('the built-in list covers genre terms, not novel names', () => {
    expect(said('<p>The NPCs in the MMORPG gathered qi like a Xianxia hero.</p>')[0]).toBe('The N P Cs in the M M O R P G gathered chee like a shyen-shyah hero.');
    expect(said('<p>Nephis smiled.</p>')[0]).toBe('Nephis smiled.');
  });

  it('dictionary words keep their phoneme runs for Kokoro inside normalized sentences', () => {
    const s = items('<p>Sunny gave Nephis 5 coins, then Nephis&#39;s smile faded.</p>', { lexicons: [lex({ match: 'Nephis', ipa: 'nˈɛfɪs' })] })[0];
    expect(s?.text).toBe("Sunny gave Nephis five coins, then Nephis's smile faded.");
    expect(s?.runs).toEqual([{ t: 'Sunny gave ' }, { p: 'nˈɛfɪs' }, { t: ' five coins, then ' }, { p: 'nˈɛfɪsɪz' }, { t: ' smile faded.' }]);
  });
});

describe('source offsets (highlighting, listen from here)', () => {
  const html =
    '<p>Chapter 9 - Ash</p><p>TL note: ash is grey.</p><p>He walked 5 km [TN: far] to the gate. Read more at novelbin.com today. It was 3:30 p.m.</p><p>Name: Ash<br>Level: 3<br>STR: 4<br>AGI: 6</p><p>* * *</p><p>[Skill acquired: Ember]</p><p>“Fine,” she said. He left.</p>';
  const blocks = htmlToBlocks(html);

  for (const statTables of ['short', 'full', 'skip'] as const) {
    it(`every item points at real text in its block (${statTables})`, () => {
      const s = speechScript(blocks, { statTables }).items;
      for (const it of s) {
        const text = blocks[it.block]?.text ?? '';
        expect(it.start).toBeGreaterThanOrEqual(0);
        expect(it.end).toBeLessThanOrEqual(text.length);
        expect(it.end).toBeGreaterThan(it.start);
        const shown = text.slice(it.start, it.end);
        expect(shown.trim()).toBe(shown);
        expect(it.hash).toBe(segmentHash(shown));
        expect(shown).not.toMatch(/novelbin|TL note/);
      }
      expect(s.every((x, i) => i === 0 || x.id > (s[i - 1]?.id ?? -1))).toBe(true);
    });
  }

  it('an inline note keeps the sentence whole for highlighting but isn’t said', () => {
    const it2 = speechScript(blocks).items.find((i) => i.text.startsWith('He walked'));
    expect(it2?.text).toBe('He walked five kilometers to the gate.');
    expect(blocks[it2?.block ?? 0]?.text.slice(it2?.start, it2?.end)).toBe('He walked 5 km [TN: far] to the gate.');
  });

  it('NarrationSegment handover: text, kind, source range; skipped text never reaches it', () => {
    const segs = narrationSegments(blocks);
    expect(segs.map((s) => s.kind)).toEqual(['normal', 'normal', 'normal', 'system', 'system', 'normal']);
    expect(segs.map((s) => s.text).join(' ')).not.toMatch(/ash is grey|novelbin/);
    for (const s of segs) expect(blocks[s.block]?.text.slice(s.start, s.end).length).toBe(s.end - s.start);
  });

  it('the UI and the core build the same script from the same chapter (deterministic)', () => {
    expect(JSON.stringify(speechScript(blocks, { lexicons: [lex({ match: 'Ash', say: 'ash' })] }))).toBe(JSON.stringify(speechScript(htmlToBlocks(html), { lexicons: [lex({ match: 'Ash', say: 'ash' })] })));
  });
});

describe('settings', () => {
  it('normalizes stored settings', () => {
    expect(normalizeTextPrep(undefined)).toEqual({ skipNotes: true, statTables: 'short' });
    expect(normalizeTextPrep({ skipNotes: false, statTables: 'full' })).toEqual({ skipNotes: false, statTables: 'full' });
    expect(normalizeTextPrep({ skipNotes: 'no', statTables: 'everything' })).toEqual({ skipNotes: true, statTables: 'short' });
  });
});

describe('speed', () => {
  const PARAS = [
    '“Wait,” Sunny said quietly, “are you sure this is the right way? We have 3 hours, maybe 4.”',
    'The rain had stopped by the time they reached the old bridge, and for a moment the whole city seemed to hold its breath while the lanterns flickered.',
    '[Skill acquired: Shadow Step (Rank II)]',
    'He spent 1,250 gold coins on a Lv. 5 sword with +10 STR and 15% more damage.',
    'Nephis glanced at him. “Tsk. Not again,” she muttered, and drew her blade.',
    'Back in 1999, at 3:30 p.m., the gate had opened for the first time in 200 years.',
    'Name: Sunny<br>Level: 5<br>STR: 12<br>AGI: 9',
    'He gathered qi [TN: life energy] in his dantian. Read more at novelbin.com today.',
  ];
  function chapter(words: number): SourceBlock[] {
    let html = '<p>Chapter 12 - The Bridge</p>';
    let n = 0;
    for (let i = 0; n < words; i++) {
      const p = PARAS[i % PARAS.length] as string;
      html += `<p>${p}</p>`;
      n += p.split(/\s+/).length;
    }
    return htmlToBlocks(html);
  }
  const median = (f: () => void): number => {
    for (let k = 0; k < 3; k++) f();
    const t: number[] = [];
    for (let k = 0; k < 9; k++) {
      const a = performance.now();
      f();
      t.push(performance.now() - a);
    }
    return t.sort((a, b) => a - b)[4] ?? 0;
  };

  it('prepares a 5,000-word chapter in under 20 ms (on the PC; scaled to this machine)', () => {
    const blocks = chapter(5000);
    const lexicons = [lex({ match: 'Nephis', say: 'NEF-iss' }, { match: 'Sunny', ipa: 'sˈʌni' })];
    const prep = median(() => prepareScript(blocks, { lexicons }));
    // v1's segmentation alone (buildScript) takes ~8.5 ms on the PC: slower machines (CI, a busy PC) get a
    // proportionally larger budget, so this checks our cost, not the machine.
    const scale = Math.max(1, median(() => buildScript(blocks)) / 8.5);
    expect(prep, `prepare ${prep.toFixed(1)} ms, machine scale ${scale.toFixed(2)}`).toBeLessThan(20 * scale);
  });
});
