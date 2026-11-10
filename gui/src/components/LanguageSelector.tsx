import React, { useState, useRef, useEffect } from "react";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LANGUAGES } from "@/i18n/languages";

/**
 * Selettore lingua: icona sotto le sezioni della Sidebar. Al clic apre la
 * lista delle lingue (nome nativo). La scelta è persistente tra sessioni
 * (i18next LanguageDetector -> localStorage).
 */
export const LanguageSelector: React.FC = () => {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const current =
    LANGUAGES.find((l) => l.code === i18n.language) ??
    LANGUAGES.find((l) => i18n.language?.startsWith(l.code)) ??
    LANGUAGES[0];

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("language.select")}
        className="flex gap-2 items-center p-2 w-full rounded-lg cursor-pointer transition-colors hover:bg-mid-gray/20 opacity-85 hover:opacity-100"
      >
        <Languages width={20} height={20} className="shrink-0" />
        <span className="text-sm font-medium truncate">{current.nativeName}</span>
      </button>

      {open && (
        <div className="absolute bottom-full mb-1 left-0 right-0 max-h-72 overflow-y-auto bg-background border border-mid-gray/30 rounded-lg shadow-lg z-50 py-1">
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              type="button"
              onClick={() => {
                i18n.changeLanguage(lang.code);
                setOpen(false);
              }}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left hover:bg-mid-gray/20 ${
                lang.code === current.code ? "text-logo-primary font-medium" : ""
              }`}
            >
              <span className="flex-1 truncate">{lang.nativeName}</span>
              <span className="text-xs text-text/40">{lang.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
