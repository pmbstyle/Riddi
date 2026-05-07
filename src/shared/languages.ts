export const SUPERTONIC_LANGUAGES = [
  'en',
  'ko',
  'ja',
  'ar',
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'et',
  'fi',
  'fr',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'lt',
  'lv',
  'nl',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'tr',
  'uk',
  'vi'
] as const;

export type SupportedLanguage = (typeof SUPERTONIC_LANGUAGES)[number];
export type LanguageSetting = SupportedLanguage | 'auto';

export const DEFAULT_SUPERTONIC_LANGUAGE: SupportedLanguage = 'en';

export const SUPERTONIC_LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  ko: 'Korean',
  ja: 'Japanese',
  ar: 'Arabic',
  bg: 'Bulgarian',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  es: 'Spanish',
  et: 'Estonian',
  fi: 'Finnish',
  fr: 'French',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  lt: 'Lithuanian',
  lv: 'Latvian',
  nl: 'Dutch',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sk: 'Slovak',
  sl: 'Slovenian',
  sv: 'Swedish',
  tr: 'Turkish',
  uk: 'Ukrainian',
  vi: 'Vietnamese'
};

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPERTONIC_LANGUAGES);

export function isSupportedLanguage(language: string): language is SupportedLanguage {
  return SUPPORTED_LANGUAGE_SET.has(language);
}

export function normalizeLanguageCode(language: string | null | undefined): SupportedLanguage | null {
  if (!language) return null;

  const normalized = language.trim().toLowerCase().replace('_', '-');
  if (!normalized) return null;

  const primary = normalized.split('-')[0];
  return isSupportedLanguage(primary) ? primary : null;
}

export function resolveLanguageSetting(
  setting: LanguageSetting,
  detected?: SupportedLanguage | null
): SupportedLanguage {
  return setting === 'auto' ? detected ?? DEFAULT_SUPERTONIC_LANGUAGE : setting;
}
