/** Parser for THIRD_PARTY_NOTICES.md (see third-party.ts). No imports: unit-tested on its own. */
export interface Notice {
  name: string;
  license: string;
  text: string;
}

const FENCE = '```';

export function parseNotices(md: string): Notice[] {
  const out: Notice[] = [];
  const sections = md.split(/^## /m).slice(1);
  let apache = '';
  for (const sec of sections) {
    const name = (sec.split('\n')[0] ?? '').trim();
    const license = /^- License: (.+)$/m.exec(sec)?.[1]?.trim() ?? '';
    const start = sec.indexOf(`${FENCE}text\n`);
    const end = start >= 0 ? sec.indexOf(`\n${FENCE}`, start + 8) : -1;
    const text = start >= 0 && end > start ? sec.slice(start + 8, end) : '';
    if (!name || !text) continue;
    if (name === 'Apache License 2.0') apache = text;
    out.push({ name, license, text });
  }
  return out
    .filter((n) => n.name !== 'Apache License 2.0')
    .map((n) => (apache && /full text in "Apache License 2\.0" below/.test(n.text) ? { ...n, text: `${n.text}\n\n${apache}` } : n));
}
