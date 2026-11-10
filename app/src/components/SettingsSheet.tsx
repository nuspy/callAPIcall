import { useEffect, useState } from "react";
import { Wav2LipBench } from "./Wav2LipBench";
import { Capacitor } from "@capacitor/core";
import { GestioneAvatar } from "./GestioneAvatar";
import { ProvaModoA } from "./ProvaModoA";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { AppSettings } from "@/lib/settings";

const VOICES = [
  ["im_nicola", "Italiano (M)"], ["if_sara", "Italiano (F)"],
  ["af_heart", "English US (F)"], ["am_michael", "English US (M)"],
  ["ff_siwis", "Français (F)"], ["ef_dora", "Español (F)"],
];

export function SettingsSheet({
  initial, onClose, onSave,
}: {
  initial: AppSettings;
  onClose: () => void;
  onSave: (s: AppSettings) => void;
}) {
  const { t, i18n } = useTranslation();
  const [s, setS] = useState<AppSettings>(initial);
  const [bench, setBench] = useState(false);
  const [gestione, setGestione] = useState(false);
  const [provaA, setProvaA] = useState(false);
  const host = (initial.gatewayUrl.match(/\/\/([^:/]+)/) || [])[1] || "127.0.0.1";
  const nativo = Capacitor.isNativePlatform();   // il modo A serve il plugin nativo
  // Base delle API: nell'app installata il media server (porta 8772, che gira
  // /personas al control); sul web la stessa origine della pagina (dietro il
  // proxy https). Un solo canale, così l'editor bocca e il CRUD funzionano anche
  // via myai.tadamoo.com. Combacia con controller.mediaBase().
  const apiBase = nativo
    ? `http://${host}:8772`
    : window.location.href.replace(/[^/]*$/, "").replace(/\/$/, "");
  // Elenco degli avatar disponibili, chiesto al bridge. Il gateway sta sulla
  // stessa macchina del control server: si ricava l'host dall'URL del gateway.
  const [personas, setPersonas] = useState<string[]>([]);
  const caricaPersonas = () => {
    fetch(`http://${host}:8770/personas`, { signal: AbortSignal.timeout(6000) })
      .then((r) => r.json())
      .then((d) => setPersonas((d.personas ?? []).map((p: any) => p.name).filter(Boolean)))
      .catch(() => setPersonas([]));   // bridge irraggiungibile: campo libero
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(caricaPersonas, [initial.gatewayUrl]);

  const field = "w-full rounded-lg bg-panel border border-slate-700 px-3 py-2 text-sm";

  return (
    <>
    {bench && <Wav2LipBench onClose={() => setBench(false)}
      modelUrl={`${apiBase}/models/wav2lip.onnx`} />}
    {gestione && <GestioneAvatar apiBase={apiBase} onClose={() => setGestione(false)}
      onCambi={caricaPersonas} />}
    {provaA && <ProvaModoA onClose={() => setProvaA(false)}
      apiBase={apiBase} persona={s.persona || "Andrea_Taini"} />}
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end" onClick={onClose}>
      {/* max-height + scroll: con molti campi il bottom-sheet superava
          l'altezza dello schermo e gli ultimi controlli (fra cui la misura
          Wav2Lip e Salva) restavano sotto il bordo, irraggiungibili. */}
      <div className="w-full bg-bg rounded-t-2xl p-4 safe-bottom max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">{t("settings")}</h2>
          <button onClick={onClose}><X /></button>
        </div>
        <div className="space-y-3">
          <label className="block text-sm">{t("gatewayUrl")}
            <input className={field} value={s.gatewayUrl}
              onChange={(e) => setS({ ...s, gatewayUrl: e.target.value })}
              placeholder="ws://100.x.y.z:8771" />
          </label>
          <label className="block text-sm">{t("token")}
            <input className={field} value={s.token} type="password"
              onChange={(e) => setS({ ...s, token: e.target.value })} />
          </label>
          <label className="block text-sm">{t("language")}
            <select className={field} value={s.lang}
              onChange={(e) => { setS({ ...s, lang: e.target.value }); i18n.changeLanguage(e.target.value); }}>
              <option value="it">Italiano</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="block text-sm">{t("voice")}
            <select className={field} value={s.voice}
              onChange={(e) => setS({ ...s, voice: e.target.value })}>
              {VOICES.map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
            </select>
          </label>
          {/* Avatar del video. L'elenco arriva dal bridge; se non risponde
              resta il campo libero, così si può scrivere il nome a mano. */}
          <label className="block text-sm">{t("persona", { defaultValue: "Avatar (video)" })}
            {personas.length > 0 ? (
              <select className={field} value={s.persona}
                onChange={(e) => setS({ ...s, persona: e.target.value })}>
                <option value="">{t("personaCurrent", { defaultValue: "quello attivo sul PC" })}</option>
                {personas.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            ) : (
              <input className={field} value={s.persona}
                placeholder={t("personaCurrent", { defaultValue: "quello attivo sul PC" })}
                onChange={(e) => setS({ ...s, persona: e.target.value })} />
            )}
          </label>
          <button type="button"
            className="w-full rounded-lg border border-slate-700 text-slate-300 py-2 text-sm"
            onClick={() => setGestione(true)}>
            {t("gestisciAvatar", { defaultValue: "Gestisci avatar (crea · modifica · elimina)" })}
          </button>
          {/* Come si conversa. È un asse a sé, indipendente da dove esce la
              voce: prima la modalità si deduceva dall'uscita audio e il
              vivavoce era a turni per forza, perché senza cancellazione d'eco
              l'avatar si risentiva dal microfono. */}
          <label className="block text-sm">
            {t("conversazione", { defaultValue: "Conversazione" })}
            <select className={field} value={s.conversazione}
              onChange={(e) => setS({ ...s,
                conversazione: e.target.value === "continua" ? "continua" : "turni" })}>
              <option value="turni">
                {t("convTurni", { defaultValue: "A turni (premi per parlare)" })}
              </option>
              <option value="continua">
                {t("convContinua", { defaultValue: "Continua (ci si parla sopra)" })}
              </option>
            </select>
            <span className="block text-xs text-slate-400 mt-1">
              {t("convNota", { defaultValue:
                "In continua puoi interrompere mentre l'avatar parla. Se l'eco è troppa, il sistema torna ai turni e te lo dice." })}
            </span>
          </label>
          {/* Come si renderizza l'avatar. musetalk = il PC genera il video;
              visemi (modo C) = il dispositivo anima la foto con la bocca sul
              volto (alleggerisce il PC e scala a piu' utenti). */}
          <label className="block text-sm">
            {t("renderMode", { defaultValue: "Rendering avatar" })}
            <select className={field} value={s.renderMode}
              onChange={(e) => setS({ ...s,
                renderMode: (e.target.value === "visemi" ? "visemi"
                  : e.target.value === "wav2lip" ? "wav2lip" : "musetalk") })}>
              <option value="musetalk">
                {t("rmMusetalk", { defaultValue: "Video dal PC — MuseTalk (fedele)" })}
              </option>
              <option value="wav2lip" disabled={!nativo}>
                {nativo
                  ? t("rmWav2lip", { defaultValue: "Wav2Lip on-device (modo A)" })
                  : t("rmWav2lipWeb", { defaultValue: "Wav2Lip (modo A) — solo app installata" })}
              </option>
              <option value="visemi">
                {t("rmVisemi", { defaultValue: "Bocca sul volto — on-device (modo C)" })}
              </option>
            </select>
            <span className="text-[11px] text-slate-500">
              {t("rmHint", { defaultValue: "A e C animano la foto sul telefono, senza video dal PC. Il modo A (Wav2Lip) è più fedele ma parte con un po' di ritardo (genera i fotogrammi); il C è immediato ma stilizzato." })}
            </span>
          </label>
          {/* Misura del modo A: fa girare Wav2Lip sul dispositivo e dice se
              regge i 25 fps, prima di decidere se integrarlo. */}
          <button type="button"
            className="w-full rounded-lg border border-slate-700 text-slate-300 py-2 text-sm"
            onClick={() => setBench(true)}>
            {t("benchWav2lip", { defaultValue: "Misura Wav2Lip (modo A)" })}
          </button>
          <button type="button"
            className="w-full rounded-lg border border-slate-700 text-slate-300 py-2 text-sm"
            onClick={() => setProvaA(true)}>
            {t("provaModoA", { defaultValue: "Prova modo A (avatar che parla)" })}
          </button>
          <button className="w-full rounded-lg bg-accent text-white py-2.5 font-medium mt-2"
            onClick={() => onSave(s)}>{t("save")}</button>
          {/* Etichetta di build: cambia a ogni compilazione, così si capisce a
              colpo d'occhio se l'app installata e' l'ultima. */}
          <div className="text-center text-[11px] text-slate-600 pt-1">
            build {typeof __BUILD__ !== "undefined" ? __BUILD__ : "dev"}
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
