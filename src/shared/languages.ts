/**
 * Languages the Grok Voice speech-to-speech API lists as supported
 * (docs.x.ai → Speech to Speech → Supported Languages). `hint` is the code
 * passed as `audio.input.transcription.language_hint`.
 */
export type Language = {
  code: string;
  label: string;
  /** Name used inside the interpreter prompt. */
  promptName: string;
  /** Writing system, used to tell the two sides apart in same-device mode. */
  script: Script;
};

export type Script =
  | 'latin'
  | 'devanagari'
  | 'bengali'
  | 'arabic'
  | 'han'
  | 'kana'
  | 'hangul'
  | 'cyrillic';

export const LANGUAGES: readonly Language[] = [
  { code: 'hi', label: 'Hindi', promptName: 'Hindi', script: 'devanagari' },
  { code: 'de', label: 'German', promptName: 'German', script: 'latin' },
  { code: 'en', label: 'English', promptName: 'English', script: 'latin' },
  { code: 'ar-AE', label: 'Arabic (UAE)', promptName: 'Gulf Arabic (UAE)', script: 'arabic' },
  { code: 'ar-SA', label: 'Arabic (Saudi Arabia)', promptName: 'Saudi Arabic', script: 'arabic' },
  { code: 'ar-EG', label: 'Arabic (Egypt)', promptName: 'Egyptian Arabic', script: 'arabic' },
  { code: 'bn', label: 'Bengali', promptName: 'Bengali', script: 'bengali' },
  { code: 'zh', label: 'Chinese (Simplified)', promptName: 'Mandarin Chinese', script: 'han' },
  { code: 'fr', label: 'French', promptName: 'French', script: 'latin' },
  { code: 'id', label: 'Indonesian', promptName: 'Indonesian', script: 'latin' },
  { code: 'it', label: 'Italian', promptName: 'Italian', script: 'latin' },
  { code: 'ja', label: 'Japanese', promptName: 'Japanese', script: 'kana' },
  { code: 'ko', label: 'Korean', promptName: 'Korean', script: 'hangul' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)', promptName: 'Brazilian Portuguese', script: 'latin' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)', promptName: 'European Portuguese', script: 'latin' },
  { code: 'ru', label: 'Russian', promptName: 'Russian', script: 'cyrillic' },
  { code: 'es-ES', label: 'Spanish (Spain)', promptName: 'Spanish (Spain)', script: 'latin' },
  { code: 'es-MX', label: 'Spanish (Mexico)', promptName: 'Mexican Spanish', script: 'latin' },
  { code: 'tr', label: 'Turkish', promptName: 'Turkish', script: 'latin' },
  { code: 'vi', label: 'Vietnamese', promptName: 'Vietnamese', script: 'latin' },
];

export function getLanguage(code: string): Language {
  return LANGUAGES.find(l => l.code === code) ?? LANGUAGES[0]!;
}

export function isLanguage(code: unknown): code is string {
  return typeof code === 'string' && LANGUAGES.some(l => l.code === code);
}

const SCRIPT_RANGES: Record<Script, RegExp> = {
  latin: /[A-Za-zÀ-ÖØ-öø-ɏ]/g,
  devanagari: /[\u0900-\u097F]/g,
  bengali: /[\u0980-\u09FF]/g,
  arabic: /[\u0600-\u06FF\u0750-\u077F]/g,
  han: /[\u4E00-\u9FFF]/g,
  kana: /[\u3040-\u30FF\u4E00-\u9FFF]/g,
  hangul: /[\uAC00-\uD7AF\u1100-\u11FF]/g,
  cyrillic: /[\u0400-\u04FF]/g,
};

/**
 * Pick which of two languages a transcript is written in, by script.
 * Returns null when both languages share a script or the text has no letters.
 */
export function detectByScript(text: string, a: string, b: string): string | null {
  const la = getLanguage(a);
  const lb = getLanguage(b);
  if (la.script === lb.script) return null;
  const count = (s: Script) => text.match(SCRIPT_RANGES[s])?.length ?? 0;
  const ca = count(la.script);
  const cb = count(lb.script);
  if (ca === 0 && cb === 0) return null;
  // Hindi speakers mix in English words (and ASR keeps keyterm names in Latin), so any
  // real run of the non-Latin script decides when the other language is Latin.
  if (la.script === 'latin' && cb >= 2) return b;
  if (lb.script === 'latin' && ca >= 2) return a;
  return ca >= cb ? a : b;
}
