import React, { useCallback, useEffect, useRef, useState } from "react";
import { Circle, Mic, Square, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AudioPlayer } from "../ui/AudioPlayer";
import Badge from "../ui/Badge";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Textarea } from "../ui/Textarea";
import { encodeWav } from "@/lib/wavEncode";
import {
  type ClonedVoice,
  type TtsModel,
  cloneVoice,
  deleteClonedVoice,
  engineHealth,
  listClonedVoices,
  listTtsModels,
  setTtsModel,
  setTtsVoice,
  ttsTest,
  wavUrlFromBase64,
} from "@/lib/api/voiceEngineApi";
import { TtsEngineSelect } from "../TtsEngineSelect";
import { AlertTriangle, Check } from "lucide-react";

const MIN_SECONDS = 5;
const MAX_SECONDS = 15;
const NAME_RE = /^[a-zA-Z0-9_-]+$/;
type VoiceFormat = "wav" | "mp3" | "flac" | "ogg";

const VoiceRecorder: React.FC<{
  disabled: boolean;
  onRecorded: (wav: Blob) => void;
}> = ({ disabled, onRecorded }) => {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const startedAtRef = useRef(0);
  const rafRef = useRef<number>();
  const intervalRef = useRef<ReturnType<typeof setInterval>>();
  const recordingRef = useRef(false);

  const cleanup = () => {
    recordingRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = undefined;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = undefined;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
  };

  useEffect(() => cleanup, []);

  const start = async () => {
    setError(null);
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false },
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(ctx.destination);
      processor.onaudioprocess = (e) => {
        if (!recordingRef.current) return;
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      recordingRef.current = true;
      startedAtRef.current = performance.now();
      setRecording(true);
      setElapsed(0);
      // Elapsed + auto-stop via setInterval: continua anche a finestra
      // minimizzata (rAF si sospende, l'auto-stop a MAX_SECONDS non scatterebbe
      // e onaudioprocess accumulerebbe chunk oltre il limite).
      intervalRef.current = setInterval(() => {
        if (!recordingRef.current) return;
        const secs = (performance.now() - startedAtRef.current) / 1000;
        setElapsed(secs);
        if (secs >= MAX_SECONDS) stop();
      }, 200);
      // rAF SOLO per il livello (puramente visivo): puo' sospendersi se minimizzato.
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        if (!recordingRef.current) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      cleanup();
      setError(e instanceof Error ? e.message : t("voices.record.micFailed"));
    }
  };

  const stop = () => {
    const sampleRate = ctxRef.current?.sampleRate ?? 48000;
    cleanup();
    setRecording(false);
    setLevel(0);
    const total = chunksRef.current.reduce((n, c) => n + c.length, 0);
    if (total / sampleRate < MIN_SECONDS) {
      setError(t("voices.record.short", { min: MIN_SECONDS }));
      return;
    }
    const samples = new Float32Array(total);
    let offset = 0;
    for (const c of chunksRef.current) { samples.set(c, offset); offset += c.length; }
    chunksRef.current = [];
    onRecorded(encodeWav(samples, sampleRate));
  };

  const canStop = elapsed >= MIN_SECONDS;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {!recording ? (
          <Button variant="primary-soft" size="sm" onClick={start} disabled={disabled}>
            <span className="flex items-center gap-1.5">
              <Circle width={12} height={12} fill="currentColor" className="text-red-500" />
              {t("voices.record.start")}
            </span>
          </Button>
        ) : (
          <Button variant="danger" size="sm" onClick={stop} disabled={!canStop}>
            <span className="flex items-center gap-1.5">
              <Square width={12} height={12} fill="currentColor" />
              {t("common.stop")}
            </span>
          </Button>
        )}
        {recording && (
          <span className="text-sm tabular-nums text-text/70">
            {elapsed.toFixed(1)}s / {MAX_SECONDS}s
          </span>
        )}
      </div>
      {recording && (
        <div className="h-2 w-full rounded bg-mid-gray/20 overflow-hidden">
          <div
            className="h-full bg-logo-primary transition-[width] duration-75"
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
      )}
      <p className="text-xs text-text/50">{t("voices.record.hint", { min: MIN_SECONDS, max: MAX_SECONDS })}</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
};

export const VoicesSection: React.FC = () => {
  const { t } = useTranslation();
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [voices, setVoices] = useState<ClonedVoice[]>([]);
  const [cloningModels, setCloningModels] = useState<TtsModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [selectedVoice, setSelectedVoice] = useState("");
  const [newName, setNewName] = useState("");
  const [mode, setMode] = useState<"record" | "upload">("record");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sampleText, setSampleText] = useState("Hello! This is a preview of my cloned voice.");
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const ok = await engineHealth();
    setReachable(ok);
    if (!ok) return;
    try { setVoices(await listClonedVoices()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    try {
      const m = await listTtsModels();
      setCloningModels(m.models.filter((x) => x.is_cloning && x.is_downloaded));
      setSelectedModelId(m.selected);
      setSelectedVoice(m.selected_voice);
    } catch { /* engine list opzionale */ }
  }, []);

  // Engine di cloning scaricato (Chatterbox o ZONOS2)? Serve per la sintesi.
  const cloningReady = cloningModels.length > 0;

  // Imposta la voce come attiva (selected_tts_voice) e, se serve, attiva un
  // engine di cloning — stessa logica della sezione Motori voce.
  const setActive = async (name: string) => {
    setError(null);
    try {
      await setTtsVoice(name);
      setSelectedVoice(name);
      // Attiva un engine di cloning SOLO se quello corrente non lo e' gia':
      // altrimenti attivare una voce scavalcherebbe la scelta dell'utente nel
      // dropdown engine (es. ZONOS2 riportato a Chatterbox).
      const currentIsCloning = cloningModels.some((m) => m.id === selectedModelId);
      if (cloningReady && !currentIsCloning) {
        const target = cloningModels[0].id;
        await setTtsModel(target);
        setSelectedModelId(target);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { refresh(); }, [refresh]);

  const nameValid = NAME_RE.test(newName);

  const save = async (blob: Blob, format: VoiceFormat) => {
    if (!nameValid) { setError(t("voices.nameInvalid")); return; }
    setSaving(true); setError(null);
    try { await cloneVoice(newName, blob, format); setNewName(""); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() as VoiceFormat;
    if (!["wav", "mp3", "flac", "ogg"].includes(ext)) {
      setError(t("voices.upload.badFormat")); return;
    }
    save(file, ext);
  };

  const remove = async (name: string) => {
    if (!window.confirm(t("voices.deleteConfirm", { name }))) return;
    try { await deleteClonedVoice(name); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const modeTabs: { mode: "record" | "upload"; Icon: React.ComponentType<any>; label: string }[] = [
    { mode: "record", Icon: Mic, label: t("voices.new.record") },
    { mode: "upload", Icon: Upload, label: t("voices.new.upload") },
  ];

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold mb-2">{t("voices.title")}</h1>
        <p className="text-sm text-text/60">{t("voices.subtitle")}</p>
      </div>

      {reachable === false && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
          {t("voices.engineDown")}
        </div>
      )}

      {reachable && !cloningReady && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
          <AlertTriangle width={16} height={16} className="mt-0.5 shrink-0" />
          <span>{t("voices.cloningMissing")}</span>
        </div>
      )}

      {/* Scelta dell'engine TTS attivo (Chatterbox/ZONOS2/...) per la sintesi. */}
      <TtsEngineSelect onChanged={refresh} />

      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <h2 className="text-sm font-medium text-text/60">{t("voices.new.title")}</h2>
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t("voices.new.namePlaceholder")}
          disabled={saving}
        />
        {newName && !nameValid && (
          <p className="text-xs text-red-400">{t("voices.new.nameHint")}</p>
        )}
        <div className="flex gap-2 border-b border-mid-gray/30">
          {modeTabs.map(({ mode: m, Icon, label }) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                mode === m
                  ? "border-logo-primary text-logo-primary"
                  : "border-transparent text-text/60 hover:text-text"
              }`}
            >
              <Icon width={14} height={14} />
              {label}
            </button>
          ))}
        </div>
        {mode === "record" ? (
          <VoiceRecorder
            disabled={saving || !nameValid || !reachable}
            onRecorded={(wav) => save(wav, "wav")}
          />
        ) : (
          <div className="space-y-2">
            <input ref={fileRef} type="file" accept=".wav,.mp3,.flac,.ogg" className="hidden" onChange={onFile} />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={saving || !nameValid || !reachable}
            >
              <span className="flex items-center gap-1.5">
                <Upload width={14} height={14} />
                {t("voices.upload.button")}
              </span>
            </Button>
            <p className="text-xs text-text/50">{t("voices.upload.hint")}</p>
          </div>
        )}
        {saving && <p className="text-xs text-text/50">{t("voices.saving")}</p>}
      </div>

      <div className="space-y-1">
        <h2 className="text-sm font-medium text-text/60">{t("voices.sampleText")}</h2>
        <Textarea value={sampleText} onChange={(e) => setSampleText(e.target.value)} rows={2} />
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-text/60">{t("voices.list.title")}</h2>
        {voices.length === 0 ? (
          <p className="text-sm text-text/50">{t("voices.list.empty")}</p>
        ) : (
          voices.map((v) => (
            <div
              key={v.name}
              className={`rounded-lg border p-3 space-y-2 ${
                v.name === selectedVoice
                  ? "border-logo-primary/60 bg-logo-primary/5"
                  : "border-mid-gray/20"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate">{v.name}</span>
                <Badge variant="secondary">{v.format}</Badge>
                {v.name === selectedVoice && (
                  <Badge variant="success">{t("voices.active")}</Badge>
                )}
                <span className="text-xs text-text/40 ms-auto tabular-nums">
                  {v.size_bytes >= 1024 * 1024
                    ? `${(v.size_bytes / 1024 / 1024).toFixed(1)} MB`
                    : `${Math.max(1, Math.round(v.size_bytes / 1024))} KB`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <AudioPlayer
                  className="flex-1"
                  resetKey={`${v.name}:${sampleText}`}
                  onLoadRequest={async () => {
                    try {
                      const res = await ttsTest(sampleText, { voice: v.name });
                      return wavUrlFromBase64(res.audio_b64);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                      return null;
                    }
                  }}
                />
                <Button
                  variant={v.name === selectedVoice ? "secondary" : "primary-soft"}
                  size="sm"
                  onClick={() => setActive(v.name)}
                  disabled={v.name === selectedVoice}
                >
                  <span className="flex items-center gap-1.5">
                    <Check width={14} height={14} />
                    {v.name === selectedVoice ? t("voices.active") : t("voices.setActive")}
                  </span>
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onClick={() => remove(v.name)}
                  aria-label={t("voices.delete")}
                >
                  <Trash2 width={14} height={14} />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
};
