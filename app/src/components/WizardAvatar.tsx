import { useRef, useState } from "react";

/**
 * Creazione guidata di un avatar, da mobile (e, con lo stesso backend, dal
 * Control Center sul PC). Raccoglie i materiali e li manda al wizard sul
 * control server, che genera gli asset per i modi A e C.
 *
 * Nome e foto sono il minimo: con quelli l'avatar è già usabile (modo A dal
 * volto ritagliato, modo C con bocca stilizzata). Pose, video e voce migliorano
 * la resa e si possono saltare. L'elaborazione pesante è sul PC; qui si carica
 * e si aspetta.
 *
 * Ogni materiale ha DUE modi di darlo, come due pulsanti distinti: SCATTA/RIPRENDI
 * (fotocamera, `<input capture>`) e SCEGLI (galleria, `<input>` senza capture).
 * Un solo input con `capture` forzerebbe la fotocamera e nasconderebbe la
 * galleria — era il difetto di prima. La voce ha un vero registratore in-app
 * (MediaRecorder), perché `<input accept=audio capture>` su Android non apre un
 * registratore affidabile.
 */

/** Coppia di pulsanti "fotocamera / galleria" per lo stesso materiale. */
function Scelta({ accept, capture, multiplo, etichettaCam, onFile }: {
  accept: string; capture: "user" | "environment"; multiplo?: boolean;
  etichettaCam: string; onFile: (files: File[]) => void;
}) {
  const b = "flex-1 rounded-lg border border-slate-700 text-slate-300 py-3 text-center text-sm cursor-pointer active:bg-panel";
  const pren = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFile(Array.from(e.target.files ?? []));
    e.target.value = ""; // così ri-scegliere lo stesso file riscatta l'evento
  };
  return (
    <div className="mt-1 flex gap-2">
      <label className={b}>
        {etichettaCam}
        <input type="file" accept={accept} capture={capture} className="hidden" onChange={pren} />
      </label>
      <label className={b}>
        Scegli
        <input type="file" accept={accept} multiple={multiplo} className="hidden" onChange={pren} />
      </label>
    </div>
  );
}

export function WizardAvatar({ controlBase, onClose, onCreato }: {
  controlBase: string;
  onClose: () => void;
  onCreato: (persona: string) => void;
}) {
  const [nome, setNome] = useState("");
  const [foto, setFoto] = useState<File | null>(null);
  const [pose, setPose] = useState<File[]>([]);
  const [video, setVideo] = useState<File | null>(null);
  const [voce, setVoce] = useState<File | null>(null);
  const [stato, setStato] = useState<string>("");
  const [inCorso, setInCorso] = useState(false);
  const fotoUrl = useRef<string>("");

  // Registratore voce (MediaRecorder): "registra da mobile" affidabile.
  const [registrando, setRegistrando] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const scegliFoto = (f: File | null) => {
    setFoto(f);
    if (fotoUrl.current) URL.revokeObjectURL(fotoUrl.current);
    fotoUrl.current = f ? URL.createObjectURL(f) : "";
  };

  const avviaRegistrazione = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const tipo = mr.mimeType || "audio/webm";
        const ext = tipo.includes("mp4") || tipo.includes("m4a") ? "m4a" : "webm";
        setVoce(new File([new Blob(chunksRef.current, { type: tipo })], `voce.${ext}`, { type: tipo }));
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      recRef.current = mr;
      setRegistrando(true);
    } catch {
      setStato("registrazione non disponibile: usa «Scegli» per un file audio.");
    }
  };
  const fermaRegistrazione = () => {
    recRef.current?.stop();
    recRef.current = null;
    setRegistrando(false);
  };

  const nomeOk = /^[A-Za-z0-9_ ]{2,40}$/.test(nome.trim());
  const puoCreare = nomeOk && !!foto && !inCorso && !registrando;

  const carica = async (draft: string, step: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file, file.name || `${step}`);
    const r = await fetch(`${controlBase}/avatar/wizard/${draft}/${step}`, {
      method: "POST", body: fd,
    });
    if (!r.ok) throw new Error(`${step}: ${r.status}`);
  };

  const crea = async () => {
    if (!foto) return;
    setInCorso(true);
    try {
      setStato("apro la bozza…");
      const s = await (await fetch(`${controlBase}/avatar/wizard/start`, { method: "POST" })).json();
      const draft = s.draft_id as string;

      setStato("carico la foto…");
      await carica(draft, "foto", foto);
      for (const p of pose) { setStato("carico le pose…"); await carica(draft, "pose", p); }
      if (video) { setStato("carico il video…"); await carica(draft, "video", video); }
      if (voce) { setStato("carico la voce…"); await carica(draft, "voce", voce); }

      setStato("elaboro l'avatar sul PC…");
      const res = await (await fetch(`${controlBase}/avatar/wizard/${draft}/elabora`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nome.trim().replace(/ /g, "_") }),
      })).json();
      if (res.error) throw new Error(res.error);
      setStato("");
      onCreato(res.persona);
    } catch (e) {
      setStato("errore: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setInCorso(false);
    }
  };

  const campo = "w-full rounded-lg bg-panel border border-slate-700 px-3 py-2 text-sm";

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-end sm:items-center justify-center p-3"
      onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-bg p-4 flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold">Crea un avatar</h2>
          <button onClick={onClose} className="text-slate-400 px-2">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-3 py-2 min-h-0">
        <label className="block text-sm">Nome
          <input className={campo} value={nome} onChange={(e) => setNome(e.target.value)}
            placeholder="es. Marco" maxLength={40} />
          {nome && !nomeOk && (
            <span className="text-[11px] text-amber-400">2-40 caratteri: lettere, numeri, spazi.</span>
          )}
        </label>

        {/* Foto frontale — obbligatoria. Scatta (fotocamera) o Scegli (galleria). */}
        <div className="text-sm">
          <div className="flex items-center justify-between">
            <span>Foto frontale <span className="text-slate-500">(obbligatoria)</span></span>
            {fotoUrl.current && (
              <img src={fotoUrl.current} alt="" className="w-10 h-10 rounded-lg object-cover" />
            )}
          </div>
          <Scelta accept="image/*" capture="user" etichettaCam="Scatta"
            onFile={(fs) => scegliFoto(fs[0] ?? null)} />
          {foto && <span className="text-[11px] text-emerald-400">✓ foto pronta</span>}
        </div>

        {/* Materiali opzionali che migliorano la resa. */}
        <details className="text-sm" open>
          <summary className="text-slate-400 cursor-pointer py-1">Materiali extra (facoltativi)</summary>
          <div className="space-y-3 pt-2">
            {/* Pose: Scatta aggiunge una posa alla volta; Scegli ne prende più d'una. */}
            <div>
              <span className="text-slate-300">Pose (semi-profilo, bocca aperta)</span>
              <Scelta accept="image/*" capture="user" multiplo etichettaCam="Scatta"
                onFile={(fs) => setPose((p) => [...p, ...fs])} />
              {pose.length > 0 && (
                <span className="text-[11px] text-emerald-400">✓ {pose.length} pose ·
                  <button className="underline ml-1" onClick={() => setPose([])}>svuota</button>
                </span>
              )}
            </div>

            {/* Video: Riprendi (fotocamera) o Scegli. */}
            <div>
              <span className="text-slate-300">Breve video del volto che parla</span>
              <Scelta accept="video/*" capture="user" etichettaCam="Riprendi"
                onFile={(fs) => setVideo(fs[0] ?? null)} />
              {video && <span className="text-[11px] text-emerald-400">✓ video pronto</span>}
            </div>

            {/* Voce: Registra in-app (MediaRecorder) o Scegli un file audio. */}
            <div>
              <span className="text-slate-300">Campione di voce (una frase letta)</span>
              <div className="mt-1 flex gap-2">
                <button
                  onClick={registrando ? fermaRegistrazione : avviaRegistrazione}
                  className={`flex-1 rounded-lg py-3 text-center text-sm ${
                    registrando ? "bg-red-600 text-white animate-pulse" : "border border-slate-700 text-slate-300 active:bg-panel"}`}>
                  {registrando ? "◼ Ferma" : "● Registra"}
                </button>
                <label className="flex-1 rounded-lg border border-slate-700 text-slate-300 py-3 text-center text-sm cursor-pointer active:bg-panel">
                  Scegli
                  <input type="file" accept="audio/*" className="hidden"
                    onChange={(e) => { setVoce(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                </label>
              </div>
              {voce && !registrando && <span className="text-[11px] text-emerald-400">✓ voce pronta</span>}
            </div>
          </div>
        </details>
        </div>

        <div className="shrink-0 space-y-2 pt-2">
        {stato && <div className="text-[13px] text-slate-400 bg-black/30 rounded-lg p-2">{stato}</div>}

        <button onClick={crea} disabled={!puoCreare}
          className="w-full rounded-lg bg-accent text-white py-2.5 font-medium disabled:opacity-50">
          {inCorso ? "Creo…" : "Crea l'avatar"}
        </button>
        <p className="text-[11px] text-slate-500">
          Nome e foto bastano. L'elaborazione avviene sul PC e può richiedere
          qualche secondo.
        </p>
        </div>
      </div>
    </div>
  );
}
