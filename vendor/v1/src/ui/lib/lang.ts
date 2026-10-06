/**
 * BCP 47 code for a source language, so chapter text carries the right `lang` (correct hyphenation,
 * VoiceOver pronunciation). Takes an English language name (see languageName in screens/browse.tsx)
 * or a code; unknown → undefined (the page's lang="en" applies).
 */
const CODES: Readonly<Record<string, string>> = {
  arabic: 'ar',
  chinese: 'zh',
  english: 'en',
  french: 'fr',
  german: 'de',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  polish: 'pl',
  portuguese: 'pt',
  russian: 'ru',
  spanish: 'es',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
  vietnamese: 'vi',
};

export function langCode(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const l = language.trim();
  if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l)) return l;
  return CODES[l.toLowerCase()];
}
