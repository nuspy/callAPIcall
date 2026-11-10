// Lingue supportate dalla GUI. L'inglese è il default/fallback.
// `dir: "rtl"` per arabo ed ebraico (il resto è left-to-right).
// I dizionari (locales/<code>.json) sono per ora COPIE dell'inglese:
// la traduzione vera viene fatta a mano file per file.

export interface LanguageMeta {
  code: string;
  /** Nome in inglese (per le liste). */
  name: string;
  /** Nome nella lingua stessa (mostrato nel selettore). */
  nativeName: string;
  dir?: "ltr" | "rtl";
}

export const LANGUAGES: LanguageMeta[] = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "it", name: "Italian", nativeName: "Italiano" },
  { code: "ru", name: "Russian", nativeName: "Русский" },
  { code: "de", name: "German", nativeName: "Deutsch" },
  { code: "fr", name: "French", nativeName: "Français" },
  { code: "es", name: "Spanish", nativeName: "Español" },
  { code: "zh", name: "Chinese (Mandarin)", nativeName: "中文" },
  { code: "ko", name: "Korean", nativeName: "한국어" },
  { code: "uk", name: "Ukrainian", nativeName: "Українська" },
  { code: "pt", name: "Portuguese", nativeName: "Português" },
  { code: "hu", name: "Hungarian", nativeName: "Magyar" },
  { code: "he", name: "Hebrew", nativeName: "עברית", dir: "rtl" },
  { code: "el", name: "Greek", nativeName: "Ελληνικά" },
  { code: "ar", name: "Arabic", nativeName: "العربية", dir: "rtl" },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी" },
];

export const DEFAULT_LANGUAGE = "en";
export const SUPPORTED_CODES = LANGUAGES.map((l) => l.code);

export function languageDir(code: string): "ltr" | "rtl" {
  return LANGUAGES.find((l) => l.code === code)?.dir ?? "ltr";
}
