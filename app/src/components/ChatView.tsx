import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Download, FileText } from "lucide-react";
import { useChat, type Media } from "@/store/chat";
import { saveMediaToDevice } from "@/lib/save";

export function ChatView() {
  const { t } = useTranslation();
  const messages = useChat((s) => s.messages);
  const endRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Media | null>(null);
  const pressTimer = useRef<number | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const startPress = (m: Media) => {
    pressTimer.current = window.setTimeout(() => setMenu(m), 550);
  };
  const cancelPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  };

  const save = async () => {
    if (!menu) return;
    const m = menu;
    setMenu(null);
    try {
      const uri = await saveMediaToDevice(m.url, m.kind, m.name);
      toast.success(t("saved") + ": " + uri.split("/").pop());
    } catch {
      toast.error(t("saveFailed"));
    }
  };

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 text-sm px-8 text-center">
        {t("emptyChat")}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
      {messages.map((m) => (
        <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
          <div
            className={`max-w-[80%] rounded-2xl overflow-hidden ${
              m.role === "user" ? "bg-accent text-white rounded-br-sm" : "bg-panel text-slate-100 rounded-bl-sm"
            }`}
          >
            {m.media && (
              <div
                className="touch-none"
                onPointerDown={() => startPress(m.media!)}
                onPointerUp={cancelPress}
                onPointerMove={cancelPress}
                onPointerCancel={cancelPress}
                onContextMenu={(e) => { e.preventDefault(); setMenu(m.media!); }}
              >
                {m.media.kind === "image" ? (
                  <img src={m.media.url} className="max-w-full block" draggable={false} />
                ) : m.media.kind === "video" ? (
                  <video src={m.media.url} controls playsInline className="max-w-full block" />
                ) : (
                  // Un file non si mostra: si annuncia. Il tocco lo salva —
                  // stessa azione del menu, ma alla portata del pollice invece
                  // che dietro una pressione lunga che nessuno indovina.
                  <button
                    onClick={() => setMenu(m.media!)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left"
                  >
                    <FileText size={22} className="shrink-0 text-slate-300" />
                    <span className="text-[15px] leading-snug break-all">
                      {m.media.name || t("file", { defaultValue: "File" })}
                    </span>
                    <Download size={18} className="ml-auto shrink-0 text-slate-400" />
                  </button>
                )}
              </div>
            )}
            {(m.text || m.pending) && (
              <div className="px-4 py-2 text-[15px] leading-snug">
                {m.text || (m.pending ? "…" : "")}
                {m.pending && <span className="inline-block ml-1 animate-pulse">▋</span>}
              </div>
            )}
          </div>
        </div>
      ))}
      <div ref={endRef} />

      {menu && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end" onClick={() => setMenu(null)}>
          <div className="w-full bg-bg rounded-t-2xl p-2 safe-bottom" onClick={(e) => e.stopPropagation()}>
            <button onClick={save} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left hover:bg-panel">
              <Download size={20} /> {t("saveLocal")}
            </button>
            <button onClick={() => setMenu(null)} className="w-full px-4 py-3 rounded-xl text-slate-400">
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
