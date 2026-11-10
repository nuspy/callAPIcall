/// <reference types="vite/client" />
// Inizializzazione i18next per la GUI.
//
// - I dizionari sono in locales/<code>.json, caricati tutti via import.meta.glob.
// - La lingua scelta è PERSISTENTE tra sessioni (LanguageDetector -> localStorage,
//   chiave "callapicall-lang").
// - Fallback all'inglese; se manca una chiave si mostra l'inglese.
// - La direzione del documento (LTR/RTL) viene aggiornata al cambio lingua.

import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LANGUAGE, SUPPORTED_CODES, languageDir } from "./languages";

// Vite: importa ogni locales/*.json come modulo (eager) -> mappa { en: {...}, ... }.
const modules = import.meta.glob("./locales/*.json", { eager: true }) as Record<
  string,
  { default: Record<string, unknown> }
>;

const resources: Record<string, { translation: Record<string, unknown> }> = {};
for (const path in modules) {
  const code = path.replace("./locales/", "").replace(".json", "");
  resources[code] = { translation: modules[path].default };
}

export const LANG_STORAGE_KEY = "callapicall-lang";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_CODES,
    nonExplicitSupportedLngs: true, // "it-IT" -> "it"
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: LANG_STORAGE_KEY,
      caches: ["localStorage"],
    },
  });

function applyDir(lng: string) {
  const dir = languageDir(lng);
  document.documentElement.setAttribute("dir", dir);
  document.documentElement.setAttribute("lang", lng);
}

applyDir(i18n.language || DEFAULT_LANGUAGE);
i18n.on("languageChanged", applyDir);

export default i18n;
