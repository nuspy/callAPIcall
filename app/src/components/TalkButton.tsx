import { useEffect, useRef, useState } from "react";
import { Mic, Brain, Volume2, Lock, Phone, PhoneOff, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChat } from "@/store/chat";
import type { VoiceController } from "@/lib/controller";
import type { AudioOutputMode } from "@/lib/audioOutput";
import { TalkRing } from "./TalkRing";

// Pillola schiacciata: circa un terzo dell'altezza del vecchio tondo da
// 112 px, per lasciare spazio all'avatar. Gli 11 (44 px) di altezza stanno
// sotto i 48 dp di Material, ma il bersaglio resta ampio per la larghezza
// (208 px) ed e' l'unico comando in quella zona: nessun vicino da sbagliare.
const PILL = "relative w-52 h-11 rounded-full text-white shadow-lg "
  + "flex items-center justify-center gap-2 transition-colors touch-none "
  + "overflow-hidden";

const DRAG_THRESHOLD = 60; // px verso l'alto per bloccare la modalità continua

export function TalkButton({
  controller,
  output,
  conversazione,
}: {
  controller: VoiceController;
  output: AudioOutputMode;
  conversazione: "turni" | "continua";
}) {
  const { t } = useTranslation();
  const phase = useChat((s) => s.phase);
  const duplex = conversazione === "continua";

  // --- comune: colore/icona/etichetta dallo stato ---
  const color =
    phase === "speaking" ? "bg-accent2"
    : phase === "reasoning" ? "bg-amber-600"
    : phase === "listening" ? "bg-accent"
    : "bg-slate-700";
  const label =
    phase === "speaking" ? t("speaking")
    : phase === "reasoning" ? t("reasoning")
    : phase === "listening" ? t("listening")
    : t("idle");

  // TUTTI gli hook stanno qui, PRIMA del ramo duplex: erano sparsi anche dopo
  // il `return` condizionale, e cambiare uscita audio faceva variare il numero
  // di hook fra un render e l'altro — che per React è un errore, non una
  // sfumatura (stato perso o crash del componente).
  const [active, setActive] = useState(false);
  const startY = useRef<number | null>(null);
  const startX = useRef<number | null>(null);
  const [locked, setLocked] = useState(false);
  // Trascinamento LATERALE: il turno diventa "detta e correggi".
  const [toText, setToText] = useState(false);
  const [pressing, setPressing] = useState(false);
  // Ref oltre allo stato: `end()` viene chiamato anche da listener registrati
  // su window, che vedrebbero il valore catturato alla registrazione.
  const pressingRef = useRef(false);

  const begin = async (x: number, y: number) => {
    startY.current = y;
    startX.current = x;
    setLocked(false);
    setToText(false);
    pressingRef.current = true;
    setPressing(true);
    await controller.onPressStart();
  };
  const move = (x: number, y: number) => {
    if (startY.current == null || locked || toText) return;
    // SU = mani libere (continuo). DI LATO = detta e correggi: al rilascio
    // arriva la sola trascrizione, in un campo di testo modificabile.
    if (startY.current - y > DRAG_THRESHOLD) {
      setLocked(true);
      controller.lockContinuous();
      return;
    }
    if (startX.current != null && Math.abs(x - startX.current) > DRAG_THRESHOLD) {
      setToText(true);
      controller.lockTranscribe();
    }
  };
  const end = async () => {
    if (!pressingRef.current) return;
    pressingRef.current = false;
    setPressing(false);
    startY.current = null;
    await controller.onPressEnd();
    setLocked(false);
    setToText(false);
  };

  // Il rilascio si ascolta sulla FINESTRA, non solo sul pulsante: durante la
  // pressione il componente si ri-renderizza (cambiano colore, scala e stato)
  // e nella WebView Android la pointer capture si perde, così `pointerup` non
  // arrivava mai al bottone — che restava premuto come se fosse stato bloccato
  // col trascinamento. `blur` copre il caso dell'app mandata in secondo piano
  // a dito ancora giù.
  useEffect(() => {
    if (!pressing) return;
    const fine = () => { void end(); };
    window.addEventListener("pointerup", fine);
    window.addEventListener("pointercancel", fine);
    window.addEventListener("blur", fine);
    return () => {
      window.removeEventListener("pointerup", fine);
      window.removeEventListener("pointercancel", fine);
      window.removeEventListener("blur", fine);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pressing]);

  // ====== AURICOLARE / BLUETOOTH: toggle comunicazione ======
  if (duplex) {
    const toggle = async () => setActive(await controller.toggleDuplex());
    const Icon = active ? PhoneOff : Phone;
    return (
      <div className="flex flex-col items-center gap-1.5 select-none w-full">
        <button
          /* VERDE = audio spento (premi per attivare), ROSSO = audio attivo.
             Il colore dice lo stato dell'AUDIO; quello della conversazione
             (ragiona / parla) lo dice l'anello che scorre, senza sovrapporsi. */
          className={`${PILL} ${active ? "bg-red-600" : "bg-emerald-600"}`}
          onClick={toggle}
        >
          <TalkRing phase={active ? phase : "idle"} />
          <Icon size={20} />
          <span className="text-sm font-medium">
            {active ? label : t("tapToCall")}
          </span>
        </button>
        <div className="text-[11px] text-slate-500">
          {active ? t("tapToHangup") : t("duplexHint")}
        </div>
      </div>
    );
  }

  // ====== VIVA VOCE: hold + drag-up (a turni) ======
  const Icon = phase === "speaking" ? Volume2 : phase === "reasoning" ? Brain : Mic;
  return (
    <div className="flex flex-col items-center gap-1.5 select-none w-full">
      <button
        /* Stessa pillola del ramo duplex. In viva voce il "premuto" e' uno
           stato tattile momentaneo, quindi l'arancione del press vince sul
           colore di base: e' l'unico modo di sentire che il dito ha preso. */
        className={`${PILL} ${
          pressing ? "bg-orange-500" : active ? "bg-red-600" : "bg-emerald-600"
        } ${pressing ? "scale-105" : ""}`}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); begin(e.clientX, e.clientY); }}
        onPointerMove={(e) => move(e.clientX, e.clientY)}
        onPointerUp={() => end()}
        onPointerCancel={() => end()}
      >
        <TalkRing phase={phase} />
        <Icon size={20} />
        <span className="text-sm font-medium">
          {toText ? t("toTextHint", { defaultValue: "correggi" })
            : locked ? t("continuousHint")
            : phase === "idle" ? t("holdToTalk")
            : label}
        </span>
        {locked && <Lock size={14} />}
        {toText && <Pencil size={14} />}
      </button>
      <div className="text-[11px] text-slate-500 text-center">
        {t("dragUpHint", { defaultValue: "su = mani libere" })} · {t("dragSideHint", { defaultValue: "di lato = correggi" })}
      </div>
    </div>
  );
}
