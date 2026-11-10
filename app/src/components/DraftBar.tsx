import { useEffect, useRef, useState } from "react";
import { Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChat } from "@/store/chat";
import type { VoiceController } from "@/lib/controller";

/**
 * Barra di correzione del testo dettato.
 *
 * Compare quando si trascina il pulsante DI LATO: il gateway restituisce la
 * sola trascrizione e si ferma, così la si può sistemare prima che l'agente la
 * veda. Serve quando il riconoscimento sbaglia un nome o una parola — correggere
 * a voce costa più che scrivere.
 *
 * La tastiera si apre da sola (`autoFocus`) perché la barra appare proprio per
 * quello; e la si può chiudere senza inviare, buttando via la bozza.
 */
export function DraftBar({ controller }: { controller: VoiceController }) {
  const { t } = useTranslation();
  const draft = useChat((s) => s.draft);
  const setDraft = useChat((s) => s.setDraft);
  const [testo, setTesto] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTesto(draft);
    if (draft) {
      // Il focus arriva dopo il render, altrimenti la WebView non apre la
      // tastiera; il cursore va in fondo, dove si corregge di solito.
      setTimeout(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }, 60);
    }
  }, [draft]);

  if (!draft) return null;

  const invia = async () => {
    const t2 = testo.trim();
    setDraft("");
    if (!t2) return;
    useChat.getState().addUser(t2);
    await controller.sendTypedText(t2);
  };

  return (
    <div className="w-full px-3 pb-2">
      <div className="rounded-2xl border border-orange-500/40 bg-panel p-2">
        <div className="text-[11px] text-orange-400 px-1 pb-1">
          {t("draftTitle", { defaultValue: "Correggi e invia" })}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={ref}
            value={testo}
            onChange={(e) => setTesto(e.target.value)}
            rows={2}
            enterKeyHint="send"
            className="flex-1 resize-none bg-transparent outline-none text-base px-2 py-1 min-h-[48px]"
            placeholder={t("draftPlaceholder", { defaultValue: "il tuo messaggio…" })}
            onKeyDown={(e) => {
              // Invio manda, Maiusc+Invio va a capo: come in una chat.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void invia();
              }
            }}
          />
          <button
            onClick={() => setDraft("")}
            aria-label={t("draftDiscard", { defaultValue: "Annulla" })}
            className="w-11 h-11 rounded-full flex items-center justify-center text-slate-400"
          >
            <X size={18} />
          </button>
          <button
            onClick={() => void invia()}
            aria-label={t("draftSend", { defaultValue: "Invia" })}
            className="w-11 h-11 rounded-full bg-orange-500 text-white flex items-center justify-center shadow"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
