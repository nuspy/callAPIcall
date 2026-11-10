import { useEffect, useState } from "react";
import { WizardAvatar } from "./WizardAvatar";
import { EditorBocca } from "./EditorBocca";

/**
 * Gestione degli avatar: la lista con le azioni CRUD (crea, modifica la bocca,
 * elimina), al posto del solo pulsante "crea". Prende il posto di quello nelle
 * impostazioni; da qui si arriva al wizard di creazione e all'editor manuale
 * della bocca. Alla chiusura, chi la mostra ricarica la propria lista, così un
 * avatar appena creato compare subito.
 */
export function GestioneAvatar({ apiBase, onClose, onCambi }: {
  apiBase: string; onClose: () => void; onCambi?: () => void;
}) {
  const controlBase = apiBase;   // il media server proxa /personas e /avatar al control
  const [lista, setLista] = useState<string[]>([]);
  const [caricando, setCaricando] = useState(true);
  const [wizard, setWizard] = useState(false);
  const [bocca, setBocca] = useState<string | null>(null);
  const [confermaElimina, setConfermaElimina] = useState<string | null>(null);
  const [errore, setErrore] = useState("");

  const carica = () => {
    setCaricando(true);
    fetch(`${controlBase}/personas`, { signal: AbortSignal.timeout(6000) })
      .then((r) => r.json())
      .then((d) => setLista((d.personas ?? []).map((p: any) => p.name).filter(Boolean)))
      .catch(() => setErrore("bridge irraggiungibile"))
      .finally(() => setCaricando(false));
  };
  useEffect(carica, []);

  const elimina = async (nome: string) => {
    setConfermaElimina(null);
    try {
      const r = await fetch(`${controlBase}/personas/${encodeURIComponent(nome)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`${r.status}`);
      carica();
      onCambi?.();
    } catch (e) {
      setErrore("eliminazione fallita: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const riga = "flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2";
  const btn = "rounded-md px-3 py-2 text-sm";

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-end sm:items-center justify-center p-3"
      onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-bg p-4 space-y-3 max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Gestisci avatar</h2>
          <button onClick={onClose} className="text-slate-400 px-2">✕</button>
        </div>

        <button onClick={() => setWizard(true)}
          className="w-full rounded-lg bg-accent text-white py-2.5 font-medium">
          + Crea nuovo avatar
        </button>

        {errore && <div className="text-[13px] text-amber-400 bg-black/30 rounded-lg p-2">{errore}</div>}
        {caricando && <div className="text-[13px] text-slate-500">Carico la lista…</div>}

        <div className="space-y-2">
          {lista.map((nome) => (
            <div key={nome} className={riga}>
              <span className="flex-1 text-sm truncate">{nome}</span>
              {confermaElimina === nome ? (
                <>
                  <span className="text-[12px] text-slate-400">Eliminare?</span>
                  <button onClick={() => elimina(nome)} className={`${btn} bg-red-600 text-white`}>Sì</button>
                  <button onClick={() => setConfermaElimina(null)} className={`${btn} border border-slate-700 text-slate-300`}>No</button>
                </>
              ) : (
                <>
                  <button onClick={() => setBocca(nome)} className={`${btn} border border-slate-700 text-slate-300`}>Bocca</button>
                  <button onClick={() => setConfermaElimina(nome)} className={`${btn} border border-slate-700 text-red-400`}>Elimina</button>
                </>
              )}
            </div>
          ))}
          {!caricando && lista.length === 0 && (
            <div className="text-[13px] text-slate-500">Nessun avatar. Creane uno.</div>
          )}
        </div>

        <p className="text-[11px] text-slate-500">
          «Bocca» apre l'editor per segnare i due angoli della bocca (meglio col
          mouse sul PC): è quello che allinea il labiale del modo A.
        </p>
      </div>

      {wizard && (
        <WizardAvatar controlBase={controlBase} onClose={() => setWizard(false)}
          onCreato={() => { setWizard(false); carica(); onCambi?.(); }} />
      )}
      {bocca && (
        <EditorBocca apiBase={apiBase} persona={bocca} onClose={() => setBocca(null)} />
      )}
    </div>
  );
}
