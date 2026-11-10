import React, { useCallback, useEffect, useState } from "react";
import { Brain, Save, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";
import {
  type PersonaMemory,
  clearPersonaMemory,
  forgetPersonaSession,
  getPersonaMemory,
  setPersonaProfile,
} from "@/lib/api/bridgeApi";

interface Props {
  persona: string;
  onClose: () => void;
}

/**
 * Memoria di una persona, in forma leggibile: il profilo durevole in un'area di
 * testo e le conversazioni ricordate in elenco, ognuna con il suo cestino.
 * Sotto resta un `memory.json`, che però non si vede mai.
 *
 * La distinzione fra le due parti è la cosa che conta: il PROFILO viene
 * rigenerato a fine sessione fondendo quello vecchio col riassunto nuovo,
 * quindi un fatto entrato lì sopravvive alla cancellazione della conversazione
 * da cui proveniva. Per dimenticare davvero qualcosa va tolto dal profilo.
 */
export const PersonaMemoryDialog: React.FC<Props> = ({ persona, onClose }) => {
  const { t } = useTranslation();
  const [mem, setMem] = useState<PersonaMemory | null>(null);
  const [profilo, setProfilo] = useState("");
  const [sporco, setSporco] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [salvato, setSalvato] = useState(false);

  const carica = useCallback(async () => {
    try {
      const m = await getPersonaMemory(persona);
      setMem(m);
      setProfilo(m.profile);
      setSporco(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [persona]);

  useEffect(() => { carica(); }, [carica]);

  const quando = (ts: number | null) =>
    ts ? new Date(ts * 1000).toLocaleString() : "—";

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await carica();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("memory.title", { defaultValue: "Memoria" })}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl my-8 rounded-lg border border-mid-gray/30 bg-background shadow-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Brain width={16} height={16} className="text-logo-primary" />
          <div className="flex-1">
            <h2 className="text-sm font-medium">
              {t("memory.dialogTitle", {
                defaultValue: "Memoria di {{persona}}", persona })}
            </h2>
            <p className="text-xs text-text/60">
              {t("memory.subtitle", {
                defaultValue: "{{n}} conversazioni in tutto · ultima {{quando}}",
                n: mem?.sessions_count ?? 0,
                quando: quando(mem?.last_seen_ts ?? null),
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close", { defaultValue: "Chiudi" })}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded hover:bg-mid-gray/20"
          >
            <X width={16} height={16} />
          </button>
        </div>

        {/* PROFILO DUREVOLE */}
        <div className="space-y-1">
          <label className="text-xs text-text/60">
            {t("memory.profile", { defaultValue: "Cosa ricorda di te (profilo durevole)" })}
          </label>
          <Textarea
            value={profilo}
            rows={8}
            onChange={(e) => { setProfilo(e.target.value); setSporco(true); setSalvato(false); }}
            placeholder={t("memory.profileEmpty", {
              defaultValue: "Nessun ricordo consolidato." })}
          />
          <p className="text-[11px] text-text/40">
            {t("memory.profileHint", {
              defaultValue:
                "Viene riscritto dal modello a fine conversazione, fondendo questo testo col riassunto nuovo: quello che togli qui può tornare se resta nelle conversazioni qui sotto.",
            })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!sporco || busy !== null}
              onClick={() => run("profile", async () => {
                await setPersonaProfile(persona, profilo);
                setSalvato(true);
              })}
            >
              <span className="flex items-center gap-1.5">
                <Save width={13} height={13} />
                {busy === "profile"
                  ? t("common.saving", { defaultValue: "Salvo…" })
                  : t("common.save", { defaultValue: "Salva" })}
              </span>
            </Button>
            {salvato && !sporco && (
              <span className="text-xs text-green-400">
                {t("memory.saved", { defaultValue: "profilo aggiornato" })}
              </span>
            )}
          </div>
        </div>

        {/* CONVERSAZIONI RICORDATE */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text/60 flex-1">
              {t("memory.sessions", {
                defaultValue: "Conversazioni ricordate ({{n}})",
                n: mem?.sessions.length ?? 0 })}
            </span>
            <Button
              size="sm"
              variant="danger-ghost"
              disabled={busy !== null || !mem}
              onClick={() => {
                if (window.confirm(t("memory.clearConfirm", {
                  defaultValue:
                    "Cancellare TUTTA la memoria di {{persona}}? Profilo e conversazioni. Non è reversibile.",
                  persona }))) {
                  run("clear", () => clearPersonaMemory(persona));
                }
              }}
            >
              {t("memory.clearAll", { defaultValue: "Dimentica tutto" })}
            </Button>
          </div>
          <div className="space-y-1 max-h-72 overflow-y-auto">
            {(mem?.sessions ?? []).slice().reverse().map((s) => (
              <div
                key={s.index}
                className="flex items-start gap-2 rounded border border-mid-gray/20 p-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-text/50">{quando(s.ts)}</p>
                  <p className="text-sm text-text/85">{s.summary}</p>
                </div>
                <button
                  type="button"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded text-text/50 hover:text-red-400 hover:bg-mid-gray/20 shrink-0"
                  aria-label={t("memory.forget", { defaultValue: "Dimentica" })}
                  title={t("memory.forget", { defaultValue: "Dimentica" })}
                  disabled={busy !== null}
                  onClick={() => run(`del:${s.index}`,
                    () => forgetPersonaSession(persona, s.index))}
                >
                  <Trash2 width={14} height={14} />
                </button>
              </div>
            ))}
            {mem && mem.sessions.length === 0 && (
              <p className="text-xs text-text/50 p-2">
                {t("memory.noSessions", {
                  defaultValue: "Nessuna conversazione ricordata." })}
              </p>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
};
