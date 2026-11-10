import React, { useEffect, useMemo, useState } from "react";
import { HelpCircle, RefreshCw, Save, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { useConfigStore } from "@/stores/configStore";
import { useStatusStore } from "@/stores/statusStore";
import { type SystemGpu, componentAction, getGpuList } from "@/lib/api/bridgeApi";

/** Gruppi del form: il primo prefisso che combacia assegna il campo.
 *  `titleKey` è la chiave i18n del titolo (namespace settings.groups). */
const GROUPS: { titleKey: string; prefixes: string[] }[] = [
  { titleKey: "settings.groups.sessionVoice", prefixes: ["default_", "tts_speed", "barge_in_"] },
  { titleKey: "settings.groups.pushToTalk", prefixes: ["push_to_talk_", "ptt_"] },
  { titleKey: "settings.groups.copilot", prefixes: ["copilot_"] },
  { titleKey: "settings.groups.avatar", prefixes: ["avatar_"] },
  { titleKey: "settings.groups.gateway", prefixes: ["gateway_"] },
  { titleKey: "settings.groups.phone", prefixes: ["phone_", "auth_token", "poll_status_"] },
  { titleKey: "settings.groups.gsm", prefixes: ["gsm_", "call_transport"] },
  { titleKey: "settings.groups.hermes", prefixes: ["hermes_", "acp_"] },
  { titleKey: "settings.groups.analysis", prefixes: ["analysis_"] },
  { titleKey: "settings.groups.meetbot", prefixes: ["meetbot_"] },
  { titleKey: "settings.groups.calendar", prefixes: ["calendar_"] },
  { titleKey: "settings.groups.knowledge", prefixes: ["knowledge_"] },
  { titleKey: "settings.groups.handy", prefixes: ["handy_"] },
  { titleKey: "settings.groups.hfp", prefixes: ["hfp_", "sample_rate", "block_ms"] },
  { titleKey: "settings.groups.control", prefixes: ["control_"] },
];

/** Scelte per `avatar_fps`. Il carico e' relativo ai 25 fps nativi: il lavoro
 *  di UNet/VAE cresce col numero di fotogrammi, non con la durata del parlato. */
const FPS_AVATAR = [
  { fps: 25, carico: 100, key: "nativo" },
  { fps: 20, carico: 80, key: "leggero" },
  { fps: 16, carico: 64, key: "consigliato" },
  { fps: 12, carico: 48, key: "minimo" },
];

/** Campi lunghi resi come textarea. */
const LONG_FIELDS = new Set(["copilot_preamble", "acp_wsl_command", "acp_voice_preamble"]);

export const SettingsSection: React.FC = () => {
  const {
    config,
    restartRequiredFields,
    pending,
    saving,
    lastSave,
    error,
    load,
    setPending,
    save,
    discardPending,
  } = useConfigStore();
  const bridgeReachable = useStatusStore((s) => s.bridgeReachable);
  const [gpus, setGpus] = useState<SystemGpu[]>([]);
  const { t } = useTranslation();

  useEffect(() => {
    if (bridgeReachable && !config) load();
  }, [bridgeReachable, config, load]);

  useEffect(() => {
    if (bridgeReachable) {
      getGpuList()
        .then((r) => setGpus(r.gpus))
        .catch(() => setGpus([]));
    }
  }, [bridgeReachable]);

  const grouped = useMemo(() => {
    if (!config) return [];
    const assigned = new Set<string>();
    const out = GROUPS.map((g) => ({ titleKey: g.titleKey, keys: [] as string[] }));
    const misc: string[] = [];
    for (const key of Object.keys(config)) {
      const gi = GROUPS.findIndex((g) =>
        g.prefixes.some((p) => key === p || key.startsWith(p)),
      );
      if (gi >= 0) {
        out[gi].keys.push(key);
        assigned.add(key);
      } else {
        misc.push(key);
      }
    }
    if (misc.length) out.push({ titleKey: "settings.groups.misc", keys: misc });
    return out.filter((g) => g.keys.length > 0);
  }, [config]);

  if (!config) {
    return (
      <div className="max-w-3xl w-full mx-auto">
        <h1 className="text-xl font-semibold mb-2">{t("settings.title")}</h1>
        <p className="text-sm text-text/60">
          {bridgeReachable ? t("settings.loading") : t("settings.serverDown")}
        </p>
        {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
      </div>
    );
  }

  const currentValue = (key: string) =>
    key in pending ? pending[key] : config[key];

  const renderField = (key: string) => {
    const value = currentValue(key);
    const original = config[key];
    const dirty = key in pending;
    const needsRestart = restartRequiredFields.includes(key);
    // Descrizione/tooltip del parametro (vuota se non documentato).
    const desc = t(`settings.params.${key}`, { defaultValue: "" });

    let control: React.ReactNode;
    if (key === "avatar_fps") {
      // Fotogrammi dell'avatar: valori scelti, non una casella libera. Il
      // lavoro di UNet/VAE e' proporzionale al NUMERO di fotogrammi, quindi
      // questa e' la leva piu' diretta sul carico GPU — ma sotto una certa
      // soglia il labiale diventa a scatti, e sopra 25 non si guadagna nulla
      // perche' e' il ritmo con cui MuseTalk e' stato addestrato.
      control = (
        <select
          value={String(value ?? 25)}
          onChange={(e) => setPending(key, Number(e.target.value))}
          className="w-64 px-2 py-1 text-sm bg-background border border-mid-gray/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-logo-primary"
        >
          {FPS_AVATAR.map((f) => (
            <option key={f.fps} value={f.fps}>
              {t(`settings.avatarFps.${f.key}`, {
                fps: f.fps,
                carico: f.carico,
                defaultValue: `${f.fps} fps — ${f.carico}% di carico GPU`,
              })}
            </option>
          ))}
        </select>
      );
    } else if (key.endsWith("_gpu_index") && gpus.length > 0) {
      // Picker GPU: alimentato da /gpu/list (nvidia-smi); null = default.
      control = (
        <select
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) =>
            setPending(key, e.target.value === "" ? null : Number(e.target.value))
          }
          className="w-64 px-2 py-1 text-sm bg-background border border-mid-gray/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-logo-primary"
        >
          <option value="">(default)</option>
          {gpus.map((g) => (
            <option key={g.index} value={g.index}>
              {g.index}: {g.name} ({Math.round(g.vram_mb / 1024)} GB)
            </option>
          ))}
        </select>
      );
    } else if (typeof original === "boolean") {
      control = (
        <label className="inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={Boolean(value)}
            onChange={(e) => setPending(key, e.target.checked)}
          />
          <div className="relative w-11 h-6 bg-mid-gray/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-background-ui" />
        </label>
      );
    } else if (LONG_FIELDS.has(key)) {
      control = (
        <textarea
          value={String(value ?? "")}
          rows={3}
          onChange={(e) => setPending(key, e.target.value)}
          className="w-full px-2 py-1.5 text-xs font-mono bg-background border border-mid-gray/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-logo-primary"
        />
      );
    } else if (typeof original === "number") {
      control = (
        <input
          type="number"
          step="any"
          value={value === null || value === undefined ? "" : Number(value)}
          onChange={(e) =>
            setPending(
              key,
              e.target.value === "" ? null : Number(e.target.value),
            )
          }
          className="w-36 px-2 py-1 text-sm bg-background border border-mid-gray/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-logo-primary"
        />
      );
    } else if (original === null) {
      // Campi opzionali (device audio, modello STT): vuoto = null.
      control = (
        <input
          type="text"
          value={value === null || value === undefined ? "" : String(value)}
          placeholder="(default)"
          onChange={(e) => {
            const v = e.target.value.trim();
            setPending(key, v === "" ? null : /^-?\d+$/.test(v) ? Number(v) : v);
          }}
          className="w-36 px-2 py-1 text-sm bg-background border border-mid-gray/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-logo-primary"
        />
      );
    } else {
      control = (
        <input
          type="text"
          value={String(value ?? "")}
          onChange={(e) => setPending(key, e.target.value)}
          className="w-64 px-2 py-1 text-sm bg-background border border-mid-gray/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-logo-primary"
        />
      );
    }

    return (
      <div
        key={key}
        className={`flex items-start justify-between gap-4 px-4 py-2 ${
          dirty ? "bg-logo-primary/5" : ""
        }`}
      >
        <div className="min-w-0 pt-1">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-mono truncate" title={key}>
              {key}
              {dirty && <span className="text-logo-primary"> *</span>}
            </p>
            {desc && (
              <span title={desc} className="shrink-0 cursor-help">
                <HelpCircle
                  width={13}
                  height={13}
                  className="text-text/40 hover:text-text/70"
                />
              </span>
            )}
          </div>
          {desc && <p className="text-[11px] text-text/45 mt-0.5 max-w-md">{desc}</p>}
          {needsRestart && (
            <p className="text-[11px] text-amber-400">{t("settings.needsRestart")}</p>
          )}
        </div>
        <div className="shrink-0">{control}</div>
      </div>
    );
  };

  return (
    <div className="max-w-3xl w-full mx-auto space-y-5 pb-16">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold mb-2">{t("settings.title")}</h1>
          <p className="text-sm text-text/60">{t("settings.subtitle")}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={load} disabled={saving}>
          <span className="flex items-center gap-1.5">
            <RefreshCw width={13} height={13} />
            {t("common.reload")}
          </span>
        </Button>
      </div>

      {lastSave && lastSave.requiresRestart.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300 flex items-center gap-3">
          <span className="flex-1">
            {t("settings.savedRestartNotice")}{" "}
            {lastSave.requiresRestart.join(", ")}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => componentAction("main", "restart")}
          >
            {t("settings.restartMain")}
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {grouped.map((group) => (
        <div key={group.titleKey} className="space-y-2">
          <h2 className="text-xs font-medium text-mid-gray uppercase tracking-wide px-4">
            {t(group.titleKey)}
          </h2>
          <div className="bg-background border border-mid-gray/20 rounded-lg divide-y divide-mid-gray/20">
            {group.keys.map(renderField)}
          </div>
        </div>
      ))}

      {/* Barra azioni fissa quando ci sono modifiche */}
      {Object.keys(pending).length > 0 && (
        <div className="fixed bottom-4 right-6 flex gap-2 bg-background border border-mid-gray/30 rounded-lg shadow-lg p-3 items-center">
          <span className="text-sm text-text/60">
            {t("settings.unsavedChanges", { count: Object.keys(pending).length })}
          </span>
          <Button variant="secondary" size="sm" onClick={discardPending} disabled={saving}>
            <span className="flex items-center gap-1">
              <Undo2 width={13} height={13} />
              {t("common.cancel")}
            </span>
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            <span className="flex items-center gap-1">
              <Save width={13} height={13} />
              {saving ? t("common.saving") : t("common.save")}
            </span>
          </Button>
        </div>
      )}
    </div>
  );
};
