import React, { useEffect, useState } from "react";
import { PauseCircle, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { useStatusStore } from "@/stores/statusStore";
import {
  avatarStartAndWait,
  avatarStop,
  clearStopSentinel,
  componentAction,
  getPersonas,
  isPortOpen,
  resumeAll,
  startSupervisor,
  suspendAll,
  systemRestart,
} from "@/lib/api/bridgeApi";

const STATE_STYLE: Record<string, string> = {
  running: "bg-green-500/20 text-green-400",
  loading: "bg-amber-500/20 text-amber-400",
  stopping: "bg-amber-500/20 text-amber-400",
  blocked: "bg-orange-500/20 text-orange-400",
  error: "bg-red-500/20 text-red-400",
  stopped: "bg-mid-gray/20 text-text/60",
  suspended: "bg-amber-500/10 text-amber-300",
  disabled: "bg-mid-gray/10 text-text/40",
  unreachable: "bg-red-500/20 text-red-400",
};

interface CardProps {
  title: string;
  description: string;
  state: string;
  stateLabel: string;
  detail?: string | null;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}

const ComponentCard: React.FC<CardProps> = ({
  title,
  description,
  state,
  stateLabel,
  detail,
  children,
  actions,
}) => (
  <div className="rounded-lg border border-mid-gray/20 p-4 space-y-2">
    <div className="flex items-center gap-2">
      <span className="font-medium text-sm">{title}</span>
      <span
        className={`text-xs px-2 py-0.5 rounded-full ${STATE_STYLE[state] ?? STATE_STYLE.stopped}`}
      >
        {stateLabel}
      </span>
      <div className="ms-auto flex gap-1.5">{actions}</div>
    </div>
    <p className="text-xs text-text/60">{description}</p>
    {detail && <p className="text-xs text-amber-400">{detail}</p>}
    {children}
  </div>
);

export const ComponentsSection: React.FC = () => {
  const { t } = useTranslation();
  const components = useStatusStore((s) => s.components);
  const bridgeReachable = useStatusStore((s) => s.bridgeReachable);
  const refreshComponents = useStatusStore((s) => s.refreshComponents);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  // Avvio dell'avatar dalla card: serve l'elenco identita' (l'avvio e' per
  // persona) e un messaggio locale, perche' l'errore utile (OOM CUDA) arriva
  // dalla chiamata e non dallo stato.
  const [personas, setPersonas] = useState<string[]>([]);
  const [avatarPersona, setAvatarPersona] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState<string | null>(null);

  const avatarState = !bridgeReachable
    ? "unreachable"
    : avatarBusy
      ? "loading"
      : (components?.avatar_worker?.state ?? "stopped");

  useEffect(() => {
    if (!bridgeReachable) return;
    let alive = true;
    getPersonas()
      .then((r) => {
        if (!alive) return;
        const names = (r.personas ?? []).map((p) => p.name);
        setPersonas(names);
        // Preseleziona quella attiva, altrimenti la prima disponibile.
        setAvatarPersona((cur) =>
          cur && names.includes(cur)
            ? cur
            : (components?.avatar_worker?.persona ?? names[0] ?? ""),
        );
      })
      .catch(() => {
        /* elenco identita' non disponibile: il select resta vuoto */
      });
    return () => {
      alive = false;
    };
  }, [bridgeReachable, components?.avatar_worker?.persona]);

  const startAvatar = async () => {
    if (!avatarPersona) return;
    setAvatarBusy(true);
    setAvatarMsg(null);
    try {
      await avatarStartAndWait(avatarPersona, (s) =>
        setAvatarMsg(
          s.progress
            ? `${s.progress.phase} ${Math.round(s.progress.percent)}%`
            : null,
        ),
      );
      setAvatarMsg(null);
    } catch (e) {
      setAvatarMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setAvatarBusy(false);
      refreshComponents();
    }
  };

  // Dettatura: sempre attiva, indipendente da "Sospendi". Qui si legge solo lo
  // stato: non ha ne' «Avvia» ne' «Ferma».
  const dictation = components?.dictation;
  const dictationState = !bridgeReachable ? "unreachable" : (dictation?.state ?? "disabled");

  const stopAvatar = async () => {
    setAvatarBusy(true);
    setAvatarMsg(null);
    try {
      await avatarStop();
    } catch (e) {
      setAvatarMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setAvatarBusy(false);
      refreshComponents();
    }
  };

  const act = async (
    component: string,
    action: "start" | "stop" | "restart",
  ) => {
    setBusy(`${component}:${action}`);
    setMessage(null);
    try {
      await componentAction(component as any, action);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setTimeout(refreshComponents, 1500);
    }
  };

  // Restart completo: primo click arma la conferma (10s), il secondo esegue.
  // Non è annullabile una volta partito, quindi non basta un click solo.
  const doSystemRestart = async () => {
    if (!confirmRestart) {
      setConfirmRestart(true);
      setTimeout(() => setConfirmRestart(false), 10000);
      return;
    }
    setConfirmRestart(false);
    setBusy("system:restart");
    setMessage(t("components.systemRestart.running"));
    try {
      await systemRestart();
      // Il bridge viene ucciso e rilanciato dal supervisore: la GUI perde la
      // connessione per qualche decina di secondi, è atteso.
      setMessage(t("components.systemRestart.started"));
      setTimeout(refreshComponents, 30000);
      setTimeout(refreshComponents, 60000);
      setTimeout(refreshComponents, 90000);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // Sospensione: libera la memoria e riferisce cosa e' uscito, con i numeri
  // (VRAM e commit del bridge prima/dopo). Non spegne il bridge, quindi la GUI
  // resta connessa e non serve riavviare nulla.
  const doSuspend = async () => {
    setBusy("suspend");
    setMessage(null);
    try {
      const r = await suspendAll();
      const m = r.measures;
      const misure: string[] = [];
      if (m?.vram_mb && m.vram_mb.before != null && m.vram_mb.after != null) {
        misure.push(t("components.suspend.vram", {
          defaultValue: "VRAM {{prima}} → {{dopo}} MB",
          prima: m.vram_mb.before, dopo: m.vram_mb.after,
        }));
      }
      if (m?.main_commit_gib?.before != null && m.main_commit_gib.after != null) {
        misure.push(t("components.suspend.commit", {
          defaultValue: "memoria del bridge {{prima}} → {{dopo}} GiB",
          prima: m.main_commit_gib.before, dopo: m.main_commit_gib.after,
        }));
      }
      const chiusi = Object.entries(m?.closed_commit_mb ?? {})
        .filter(([, mb]) => mb != null)
        .map(([nome, mb]) => `${nome} ${((mb as number) / 1024).toFixed(1)} GiB`);
      if (chiusi.length) {
        misure.push(t("components.suspend.closed", {
          defaultValue: "processi chiusi: {{lista}}",
          lista: chiusi.join(", "),
        }));
      }
      const base = r.released?.length
        ? t("components.suspend.done", {
            defaultValue: "Liberati: {{cosa}}. Restano attivi STT e dettatura.",
            cosa: r.released.join(", "),
          })
        : t("components.suspend.nothing", {
            defaultValue: "Non c'era nulla da liberare.",
          });
      setMessage(misure.length ? `${base} ${misure.join(" · ")}.` : base);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      refreshComponents();
    }
  };

  // Riprendi: fine della sospensione, i motori tornano caldi.
  const doResume = async () => {
    setBusy("resume");
    setMessage(null);
    try {
      await resumeAll();
      setMessage(t("components.suspend.resumed", {
        defaultValue: "Ripreso: i motori si stanno riscaldando.",
      }));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      refreshComponents();
    }
  };

  const startMainOffline = async () => {
    setBusy("bridge:start");
    setMessage(t("components.bridge.starting"));
    try {
      await clearStopSentinel();
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await isPortOpen(8770)) {
          setMessage(t("components.bridge.startedSupervisor"));
          return;
        }
      }
      setMessage(t("components.bridge.startingSupervisor"));
      await startSupervisor();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await isPortOpen(8770)) {
          setMessage(t("components.bridge.started"));
          return;
        }
      }
      setMessage(t("components.bridge.notStarted"));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      refreshComponents();
    }
  };

  const ActionButton: React.FC<{
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    variant?: "secondary" | "danger-ghost";
    disabled?: boolean;
  }> = ({ label, icon, onClick, variant = "secondary", disabled }) => (
    <Button
      variant={variant}
      size="sm"
      onClick={onClick}
      disabled={disabled || busy !== null}
      title={label}
    >
      <span className="flex items-center gap-1">
        {icon}
        {label}
      </span>
    </Button>
  );

  const bridgeComp = "main";
  const main = components?.main;
  const session = main?.session;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-semibold mb-2">{t("components.title")}</h1>
        <p className="text-sm text-text/60">{t("components.subtitle")}</p>
      </div>

      {message && (
        <div className="rounded-lg border border-mid-gray/30 bg-mid-gray/10 p-3 text-sm">
          {message}
        </div>
      )}

      {/* Cold restart di TUTTO: istanze vLLM (VRAM), modelli LM Studio, worker,
          agente, bridge, GUI, sentinelle e servizi. Doppio click di conferma:
          durante il ciclo (1-2 min) la voce e le chiamate non sono disponibili. */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{t("components.systemRestart.title")}</span>
          <div className="ms-auto">
            <Button
              variant={confirmRestart ? "danger-ghost" : "secondary"}
              size="sm"
              onClick={doSystemRestart}
              disabled={busy !== null}
              title={t("components.systemRestart.title")}
            >
              <span className="flex items-center gap-1">
                <RotateCcw width={13} height={13} />
                {confirmRestart
                  ? t("components.systemRestart.confirm")
                  : t("components.systemRestart.button")}
              </span>
            </Button>
          </div>
        </div>
        <p className="text-xs text-text/60">{t("components.systemRestart.desc")}</p>
      </div>

      {/* Libera la memoria senza spegnere: scarica avatar, motori TTS e agente,
          lascia su STT, LLM e questo bridge (quindi la GUI e le hotkey). Ogni
          pezzo si ricarica da solo al primo uso: non serve un "riprendi". */}
      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">
            {t("components.suspend.title", { defaultValue: "Sospendi tutto (libera memoria)" })}
          </span>
          <div className="ms-auto flex items-center gap-2">
            {main?.suspended && (
              <Button
                variant="secondary"
                size="sm"
                onClick={doResume}
                disabled={busy !== null || !bridgeReachable}
              >
                <span className="flex items-center gap-1">
                  <Play width={13} height={13} />
                  {busy === "resume"
                    ? t("components.suspend.resuming", { defaultValue: "riprendo…" })
                    : t("components.suspend.resume", { defaultValue: "Riprendi" })}
                </span>
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={doSuspend}
              disabled={busy !== null || !bridgeReachable}
              title={t("components.suspend.title", { defaultValue: "Sospendi tutto (libera memoria)" })}
            >
              <span className="flex items-center gap-1">
                <PauseCircle width={13} height={13} />
                {busy === "suspend"
                  ? t("components.suspend.running", { defaultValue: "libero…" })
                  : t("components.suspend.button", { defaultValue: "Sospendi" })}
              </span>
            </Button>
          </div>
        </div>
        <p className="text-xs text-text/60">
          {t("components.suspend.desc", {
            defaultValue:
              "Chiude worker avatar, motori TTS e agente (restituendo VRAM e RAM) e la sessione voce, toglie le scorciatoie push-to-talk, ferma il server dei motori voce e il watcher delle chiamate in arrivo, e mette in pausa il riscaldamento automatico dei motori. Restano attivi la trascrizione (STT), la dettatura (sempre attiva, usa lo stesso STT), il modello in LM Studio e questa interfaccia. Nulla si riaccende da solo: serve «Riprendi». La sospensione resta anche dopo i riavvii, finché non premi «Riprendi».",
          })}
        </p>
      </div>

      <ComponentCard
        title={t("components.bridge.title")}
        description={t("components.bridge.desc")}
        state={bridgeReachable ? (main?.stopping ? "stopping" : "running") : "unreachable"}
        stateLabel={t(`components.state.${bridgeReachable ? (main?.stopping ? "stopping" : "running") : "unreachable"}`)}
        detail={bridgeReachable && main?.pid ? `PID ${main.pid}` : undefined}
        actions={
          bridgeReachable ? (
            <>
              <ActionButton
                label={t("components.bridge.restart")}
                icon={<RefreshCw width={13} height={13} />}
                onClick={() => act(bridgeComp, "restart")}
              />
              <ActionButton
                label={t("components.bridge.stop")}
                variant="danger-ghost"
                icon={<Square width={13} height={13} />}
                onClick={() => act(bridgeComp, "stop")}
              />
            </>
          ) : (
            <ActionButton
              label={t("components.bridge.start")}
              icon={<Play width={13} height={13} />}
              onClick={startMainOffline}
            />
          )
        }
      >
        {session?.active && (
          <p className="text-xs text-text/60">
            {t("components.bridge.session", { mode: session.mode, phase: session.phase })}
          </p>
        )}
      </ComponentCard>

      <ComponentCard
        title={t("components.pushToTalk.title", { defaultValue: "Push-to-talk (hotkey)" })}
        description={t("components.pushToTalk.desc", {
          defaultValue:
            "Scorciatoie per sessioni voce, avatar e copilota. «Sospendi» le toglie, «Riprendi» le rimette.",
        })}
        state={bridgeReachable ? (components?.push_to_talk?.state ?? "disabled") : "unreachable"}
        stateLabel={t(`components.state.${bridgeReachable ? (components?.push_to_talk?.state ?? "disabled") : "unreachable"}`)}
      />

      <ComponentCard
        title={t("components.incomingCalls.title", { defaultValue: "Chiamate in arrivo" })}
        description={t("components.incomingCalls.desc", {
          defaultValue:
            "Il bridge vigila sulle chiamate in arrivo e risponde. «Sospendi» lo ferma, «Riprendi» lo riattiva.",
        })}
        state={bridgeReachable ? (components?.incoming_calls?.state ?? "disabled") : "unreachable"}
        stateLabel={t(`components.state.${bridgeReachable ? (components?.incoming_calls?.state ?? "disabled") : "unreachable"}`)}
      />

      <ComponentCard
        title={t("components.dictation.title", { defaultValue: "Dettatura (Alt+Spazio)" })}
        description={t("components.dictation.desc", {
          defaultValue:
            "Tieni premuta la hotkey, parla, rilascia: il testo viene incollato dove stai scrivendo. È sempre attiva e usa lo stesso modello di trascrizione delle sessioni voce, sempre in memoria: «Sospendi» non la tocca.",
        })}
        state={dictationState}
        stateLabel={t(`components.state.${dictationState}`)}
        detail={dictation?.detail ?? undefined}
      >
        {dictation && dictation.state !== "disabled" && (
          <div className="text-xs text-text/60 space-y-0.5">
            <p>
              {t("components.dictation.model", {
                defaultValue: "Modello: {{model}}",
                model: dictation.model ?? "?",
              })}
              {dictation.device && ` · ${dictation.device}`}
              {dictation.precision && ` · ${dictation.precision}`}
              {typeof dictation.vram_mb === "number" &&
                ` · ${t("components.dictation.vram", {
                  defaultValue: "VRAM {{mb}} MB",
                  mb: dictation.vram_mb,
                })}`}
            </p>
            {dictation.last && (
              <p>
                {t("components.dictation.last", {
                  defaultValue:
                    "Ultima dettatura: {{audio}} s di audio trascritti in {{ms}} ms ({{xrt}}× tempo reale)",
                  audio: dictation.last.audio_s,
                  ms: dictation.last.total_ms,
                  xrt: dictation.last.xrt,
                })}
              </p>
            )}
          </div>
        )}
      </ComponentCard>

      <ComponentCard
        title={t("components.gateway.title")}
        description={t("components.gateway.desc")}
        state={bridgeReachable ? (components?.gateway?.state ?? "stopped") : "unreachable"}
        stateLabel={t(`components.state.${bridgeReachable ? (components?.gateway?.state ?? "stopped") : "unreachable"}`)}
        actions={
          <ActionButton
            label={t("components.gateway.restartBridge")}
            icon={<RefreshCw width={13} height={13} />}
            onClick={() => act(bridgeComp, "restart")}
            disabled={!bridgeReachable}
          />
        }
      />

      <ComponentCard
        title={t("components.voiceEngine.title")}
        description={t("components.voiceEngine.desc")}
        state={bridgeReachable ? (components?.voice_engine?.state ?? "stopped") : "unreachable"}
        stateLabel={t(`components.state.${bridgeReachable ? (components?.voice_engine?.state ?? "stopped") : "unreachable"}`)}
        detail={components?.voice_engine?.detail}
        actions={
          // I motori vivono NEL processo del bridge: non esistono start/stop
          // separati, l'unica azione sensata e' riavviare il bridge.
          <ActionButton
            label={t("components.voiceEngine.restartBridge")}
            icon={<RefreshCw width={13} height={13} />}
            onClick={() => act(bridgeComp, "restart")}
            disabled={!bridgeReachable}
          />
        }
      >
        {components?.voice_engine?.models && (
          <div className="text-xs text-text/60 space-y-0.5">
            <p>
              STT:{" "}
              {components.voice_engine.models?.stt?.loaded
                ? t("components.voiceEngine.sttLoaded", { model: components.voice_engine.models?.stt?.current_model ?? "?" })
                : t("components.voiceEngine.sttNotLoaded")}
            </p>
            <p>
              TTS:{" "}
              {components.voice_engine.models?.tts?.loaded
                ? t("components.voiceEngine.ttsLoaded", { model: components.voice_engine.models?.tts?.current_model ?? "?" })
                : t("components.voiceEngine.ttsNotLoaded")}
              {typeof components.voice_engine.models?.idle_seconds === "number" &&
                ` — ${t("components.voiceEngine.idle", { s: components.voice_engine.models.idle_seconds })}`}
            </p>
          </div>
        )}
        <p className="text-xs text-text/40">{t("components.voiceEngine.nativeNote")}</p>
      </ComponentCard>

      <ComponentCard
        title={t("components.hermes.title")}
        description={t("components.hermes.desc")}
        state={bridgeReachable ? (components?.hermes?.state ?? "stopped") : "unreachable"}
        stateLabel={t(`components.state.${bridgeReachable ? (components?.hermes?.state ?? "stopped") : "unreachable"}`)}
        detail={components?.hermes?.detail}
        actions={
          <>
            <ActionButton
              label={t("components.hermes.start")}
              icon={<Play width={13} height={13} />}
              onClick={() => act("hermes", "start")}
              disabled={!bridgeReachable}
            />
            <ActionButton
              label={t("components.hermes.restart")}
              icon={<RefreshCw width={13} height={13} />}
              onClick={() => act("hermes", "restart")}
              disabled={!bridgeReachable}
            />
          </>
        }
      />

      <ComponentCard
        title={t("components.avatar.title")}
        description={t("components.avatar.desc")}
        state={avatarState}
        stateLabel={t(`components.state.${avatarState}`)}
        detail={
          components?.avatar_worker?.persona
            ? t("components.avatar.persona", { persona: components.avatar_worker.persona })
            : (avatarMsg ?? components?.avatar_worker?.detail ?? undefined)
        }
        actions={
          avatarBusy || avatarState === "running" || avatarState === "loading" ? (
            <ActionButton
              label={t("components.avatar.stop", { defaultValue: "Ferma" })}
              variant="danger-ghost"
              icon={<Square width={13} height={13} />}
              onClick={stopAvatar}
              disabled={!bridgeReachable}
            />
          ) : (
            <ActionButton
              label={t("components.avatar.start", { defaultValue: "Avvia" })}
              icon={<Play width={13} height={13} />}
              onClick={startAvatar}
              disabled={!bridgeReachable || !avatarPersona}
            />
          )
        }
      >
        {/* L'avvio richiede un'identita': senza scelta qui la card poteva solo
            guardare il worker morire. Il select resta visibile anche da fermo
            cosi' si capisce SU COSA si sta per avviare. */}
        {avatarState !== "running" && avatarState !== "loading" && (
          <select
            className="w-full rounded-md border border-mid-gray/30 bg-transparent px-2 py-1.5 text-xs"
            value={avatarPersona}
            onChange={(e) => setAvatarPersona(e.target.value)}
            disabled={!bridgeReachable || avatarBusy || personas.length === 0}
          >
            {personas.length === 0 && (
              <option value="">
                {t("components.avatar.noPersonas", {
                  defaultValue: "Nessuna identità: creane una in Identità",
                })}
              </option>
            )}
            {personas.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        {components?.avatar_worker?.preparing && (
          <p className="text-xs text-text/60">
            {t("components.avatar.preparing", {
              defaultValue: "Preparazione di {{persona}} in corso…",
              persona: components.avatar_worker.preparing,
            })}
            {components.avatar_worker.progress?.percent != null &&
              ` ${Math.round(components.avatar_worker.progress.percent)}%`}
          </p>
        )}
        <p className="text-xs text-text/40">
          {t("components.avatar.vramNote", {
            defaultValue:
              "Richiede VRAM libera: se un LLM occupa la GPU l'avvio fallisce con OOM CUDA. Usa «Libera memoria» o scarica il modello.",
          })}
        </p>
      </ComponentCard>
    </div>
  );
};
