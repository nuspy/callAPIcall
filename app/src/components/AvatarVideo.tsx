import { useEffect, useRef, useState } from "react";
import type { VoiceController } from "@/lib/controller";
import { useChat } from "@/store/chat";

/**
 * Riquadro dell'avatar. L'elemento <video> viene registrato nel controller,
 * che ci appende la traccia remota quando la connessione WebRTC è stabilita.
 *
 * `playsInline` è obbligatorio: senza, su mobile il video verrebbe aperto a
 * schermo intero dal sistema. `muted` perché l'audio della risposta viaggia
 * sul canale audio già esistente e non sulla traccia video — sentirlo due
 * volte, sfasato, sarebbe peggio che non sentirlo.
 *
 * A audio spento non c'è nessun flusso: si mostra la posa fissa dell'avatar
 * (il primo fotogramma del suo clip, servito dal media server). È la stessa
 * immagine da cui il video partirebbe, quindi all'accensione non si vede
 * nessuno scatto — e nel frattempo non lavorano né encoder né rete né il
 * decoder del telefono per mostrare una faccia che sta ferma.
 */
export function AvatarVideo({
  controller,
  visible,
  streaming,
}: {
  controller: VoiceController;
  visible: boolean;
  /** Se il flusso WebRTC è davvero aperto. Se no si mostra la posa fissa. */
  streaming: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const stato = useChat((s) => s.videoState);
  // Si rilegge a ogni accensione del riquadro: cambiando persona nelle
  // impostazioni, la posa deve seguire. Ci pensa la cache HTTP a non
  // riscaricarla ogni volta.
  const [posterKo, setPosterKo] = useState(false);
  useEffect(() => setPosterKo(false), [visible, controller]);

  useEffect(() => {
    controller.bindVideo(ref.current);
    return () => controller.bindVideo(null);
  }, [controller]);

  return (
    // A video acceso il riquadro PRENDE lo spazio libero (flex-1) invece di
    // stare in una fascia fissa: con i comandi spostati in alto e la pillola
    // al posto del tondo, quello spazio e' molto e va all'immagine.
    <div className={visible ? "flex-1 min-h-0 px-3 pb-2 relative flex" : "hidden"}>
      {/* Il rapporto NON va imposto: i video degli avatar sono verticali
          (362x480 per la persona) e un riquadro 16:9 con object-cover ne ritaglia il
          centro, mostrando mezza faccia. Con object-contain il video sta dentro
          il riquadro qualunque sia il suo formato, senza tagli né deformazioni. */}
      {/* L'elemento <video> resta MONTATO anche a flusso spento, solo
          nascosto: smontarlo perderebbe il binding col controller, e
          rimontarlo a ogni accensione darebbe un lampo nero. */}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        // `h-full` + `object-contain`: riempie il riquadro senza deformare il
        // viso, qualunque sia il rapporto della clip.
        //
        // NIENTE `rounded-*` sul <video>: per arrotondare gli angoli il browser
        // deve mascherare per-pixel ogni fotogramma. Chrome (desktop e mobile
        // pieno) lo fa in GPU a costo zero; la System WebView di Android in cui
        // gira l'app declassa spesso il video a compositing software, e a quel
        // punto scatta anche su un telefono velocissimo — non e' potenza che
        // manca, e' il percorso di rendering. L'angolo tondo lo da' il
        // contenitore; il video sotto resta a angoli vivi ma su una surface
        // hardware. `translateZ(0)` lo tiene su un layer GPU dedicato.
        style={{ transform: "translateZ(0)" }}
        className={`w-full h-full bg-black object-contain ${
          streaming ? "" : "hidden"
        }`}
      />
      {!streaming && (
        posterKo ? (
          // Nessuna posa disponibile (persona senza clip): riquadro nero, non
          // un'icona di immagine rotta.
          <div className="w-full h-full rounded-2xl bg-black" />
        ) : (
          <img
            src={controller.posterUrl()}
            alt=""
            onError={() => setPosterKo(true)}
            className="w-full h-full rounded-2xl bg-black object-contain"
          />
        )
      )}
      {stato && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <div className="flex items-center gap-3 rounded-xl bg-black/70 px-4 py-3 text-sm text-slate-200">
            <span className="w-4 h-4 rounded-full border-2 border-slate-400 border-t-transparent animate-spin" />
            <span>{stato}</span>
          </div>
        </div>
      )}
    </div>
  );
}
