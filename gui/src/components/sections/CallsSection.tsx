import React, { useEffect, useState } from "react";
import { Phone, PhoneOff, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { useStatusStore } from "@/stores/statusStore";
import { type TtsModel, listTtsModels } from "@/lib/api/voiceEngineApi";
import { VoicePicker, splitVoiceValue } from "../VoicePicker";
import {
  getStatus,
  getTransport,
  hangup,
  placeCall,
  prepare,
} from "@/lib/api/bridgeApi";

export const CallsSection: React.FC = () => {
  const { t } = useTranslation();
  const bridgeReachable = useStatusStore((s) => s.bridgeReachable);
  const [number, setNumber] = useState("");
  const [voice, setVoice] = useState("");
  const [lang, setLang] = useState("it");
  const [transportMode, setTransportMode] = useState("");
  const [catalogo, setCatalogo] = useState<TtsModel[]>([]);
  const [transport, setTransport] = useState<{ selected: string | null; mode: string } | null>(null);
  const [phone, setPhone] = useState<{ state?: string; number?: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridgeReachable) return;
    // Catalogo completo (motori + loro voci), non piu' le sole voci del
    // motore attivo: cosi' si puo' scegliere il motore anche per la chiamata.
    listTtsModels().then((m) => setCatalogo(m.models ?? [])).catch(() => {});
    getTransport().then(setTransport).catch(() => {});
    const timer = setInterval(() => {
      getStatus()
        .then((s) => setPhone(s.phone ?? null))
        .catch(() => setPhone(null));
    }, 2000);
    return () => clearInterval(timer);
  }, [bridgeReachable]);

  const refreshTransport = async () => {
    setBusy("transport");
    try {
      setTransport(await getTransport(true));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const call = async () => {
    if (!number.trim()) {
      setError(t("calls.noNumber"));
      return;
    }
    setBusy("call");
    setError(null);
    try {
      await prepare(true);
      await placeCall({
        number: number.trim(),
        // Il bridge vuole il solo nome voce: il motore lo deduce da quello
        // (e libera la memoria dell'altro prima di caricarlo).
        voice: splitVoiceValue(voice).voice || undefined,
        lang: lang || undefined,
        transport: transportMode || undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doHangup = async () => {
    setBusy("hangup");
    setError(null);
    try {
      await hangup();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const inCall = phone?.state === "OFFHOOK" || phone?.state === "RINGING";

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold mb-2">{t("calls.title")}</h1>
        <p className="text-sm text-text/60">{t("calls.subtitle")}</p>
      </div>

      <div className="rounded-lg border border-mid-gray/20 p-4 flex items-center gap-3">
        <div className="flex-1 text-sm">
          <span className="text-text/60">{t("calls.transport.detected")}: </span>
          <span className="font-medium">
            {transport?.selected ?? t("calls.transport.none")}
          </span>
          <span className="text-text/40"> {t("calls.transport.mode", { mode: transport?.mode ?? "?" })}</span>
        </div>
        <Select
          value={transportMode}
          onChange={setTransportMode}
          options={[
            { value: "", label: t("calls.transportMode.auto") },
            { value: "gsm", label: t("calls.transportMode.forceGsm") },
            { value: "android", label: t("calls.transportMode.forceAndroid") },
          ]}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={refreshTransport}
          disabled={busy === "transport" || !bridgeReachable}
        >
          <span className="flex items-center gap-1.5">
            <RefreshCw
              width={13}
              height={13}
              className={busy === "transport" ? "animate-spin" : ""}
            />
            {t("calls.transport.detect")}
          </span>
        </Button>
      </div>

      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <Input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder={t("calls.number")}
          disabled={inCall}
        />
        <div className="flex gap-3 items-start">
          <VoicePicker
            className="flex-1"
            models={catalogo}
            // Si tiene `motore:voce`: salvando la sola voce, al render dopo il
            // picker doveva indovinare il motore e finiva sul primo che ha quel
            // nome — con le voci omonime (`sara_clone` sta su più motori) il
            // menu tornava indietro da solo. Al bridge si manda comunque il
            // solo nome (vedi `call`).
            value={voice}
            onChange={(v) => setVoice(v)}
            filterLang={lang}
          />
          <Select
            value={lang}
            onChange={setLang}
            options={[
              { value: "it", label: t("calls.langs.it") },
              { value: "en-us", label: t("calls.langs.en-us") },
              { value: "fr-fr", label: t("calls.langs.fr-fr") },
              { value: "es", label: t("calls.langs.es") },
            ]}
          />
        </div>
        <div className="flex gap-3">
          <Button
            onClick={call}
            disabled={busy !== null || !bridgeReachable || inCall}
          >
            <span className="flex items-center gap-1.5">
              <Phone width={14} height={14} />
              {busy === "call" ? t("calls.calling") : t("calls.call")}
            </span>
          </Button>
          <Button
            variant="danger"
            onClick={doHangup}
            disabled={busy !== null || !bridgeReachable || !inCall}
          >
            <span className="flex items-center gap-1.5">
              <PhoneOff width={14} height={14} />
              {t("calls.hangup")}
            </span>
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-mid-gray/20 p-4 flex items-center gap-3 text-sm">
        <span
          className={`inline-block w-2.5 h-2.5 rounded-full ${
            phone?.state === "OFFHOOK"
              ? "bg-green-500 animate-pulse"
              : phone?.state === "RINGING"
                ? "bg-amber-400 animate-pulse"
                : "bg-mid-gray/40"
          }`}
        />
        <span className="text-text/60">{t("calls.phoneState")}:</span>
        <span className="font-medium">{phone?.state ?? t("calls.unknown")}</span>
        {phone?.number && <span className="text-text/60">({phone.number})</span>}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
};
