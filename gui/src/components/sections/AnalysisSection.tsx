import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  Link as LinkIcon,
  ListChecks,
  ScanSearch,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { ProgressBar } from "../ui/ProgressBar";
import { useStatusStore } from "@/stores/statusStore";
import {
  type AnalysisDetail,
  type AnalysisItem,
  analysisStartFile,
  analysisStartUrl,
  deleteAnalysis,
  getAnalysis,
  getAnalysisList,
  getAnalysisTranscript,
  renameAnalysisSpeakers,
} from "@/lib/api/bridgeApi";

const ACTIVE_STATES = new Set([
  "queued", "downloading", "extracting", "transcribing", "diarizing", "analyzing",
  "running",
]);

type Tab = "summary" | "highlights" | "tasks" | "transcript";

type Segment = {
  start_s: number;
  text: string;
  speaker?: string;
  speaker_label?: string;
};

// Il colore distingue le voci; il TESTO resta quello del tema, cosi' il
// contrasto regge sia in chiaro sia in scuro (i token del tema cambiano con
// prefers-color-scheme, le tinte sature no).
const SPEAKER_COLORS = [
  "border-sky-500/50 bg-sky-500/10",
  "border-emerald-500/50 bg-emerald-500/10",
  "border-amber-500/50 bg-amber-500/10",
  "border-violet-500/50 bg-violet-500/10",
  "border-rose-500/50 bg-rose-500/10",
  "border-cyan-500/50 bg-cyan-500/10",
];

export const AnalysisSection: React.FC = () => {
  const { t } = useTranslation();
  const bridgeReachable = useStatusStore((s) => s.bridgeReachable);
  const [items, setItems] = useState<AnalysisItem[]>([]);
  const [detail, setDetail] = useState<AnalysisDetail | null>(null);
  const [transcript, setTranscript] = useState<Segment[] | null>(null);
  const [tab, setTab] = useState<Tab>("summary");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [speakers, setSpeakers] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [savingNames, setSavingNames] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!bridgeReachable) return;
    try {
      const r = await getAnalysisList();
      setItems(r.analyses);
      setDetail((d) => d ?? null);
    } catch {}
  }, [bridgeReachable]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!detail || !ACTIVE_STATES.has(detail.state)) return;
    const timer = setInterval(async () => {
      try {
        setDetail(await getAnalysis(detail.id));
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }, [detail?.id, detail?.state]);

  const start = async (kind: "file" | "url", file?: File) => {
    setBusy(true);
    setError(null);
    try {
      const voci = Number(speakers) || 0;
      let id: string;
      if (kind === "file" && file) {
        id = await analysisStartFile(file, title || undefined, voci);
      } else {
        if (!/^https?:\/\//.test(url.trim())) {
          setError(t("analysis.form.badUrl"));
          return;
        }
        id = (await analysisStartUrl(url.trim(), title || undefined, voci)).id;
      }
      setUrl("");
      setTitle("");
      await refresh();
      setTranscript(null);
      setNames({});
      setTab("summary");
      setDetail(await getAnalysis(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string) => {
    setError(null);
    setTranscript(null);
    setNames({});
    setTab("summary");
    try {
      setDetail(await getAnalysis(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openTranscript = async () => {
    setTab("transcript");
    if (!detail || transcript) return;
    try {
      const result = await getAnalysisTranscript(detail.id);
      setTranscript(result.segments);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };

  // Voci nell'ordine in cui compaiono: chiave = etichetta originale
  // ("Speaker 1"), valore = come si chiama adesso.
  const voices: { label: string; shown: string }[] = [];
  for (const s of transcript ?? []) {
    const label = s.speaker_label ?? s.speaker;
    if (label && !voices.some((v) => v.label === label)) {
      voices.push({ label, shown: s.speaker ?? label });
    }
  }
  const colorOf = (label: string) => {
    const i = voices.findIndex((v) => v.label === label);
    return SPEAKER_COLORS[(i < 0 ? 0 : i) % SPEAKER_COLORS.length];
  };

  const saveNames = async () => {
    if (!detail) return;
    setSavingNames(true);
    setError(null);
    try {
      await renameAnalysisSpeakers(detail.id, names);
      // Rilettura: i nomi si applicano in lettura, quindi il transcript e
      // l'analisi (task intestati alle voci) vanno ripresi dal bridge.
      const [d, tr] = await Promise.all([
        getAnalysis(detail.id),
        getAnalysisTranscript(detail.id),
      ]);
      setDetail(d);
      setTranscript(tr.segments);
      setNames({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingNames(false);
    }
  };

  if (detail) {
    const active = ACTIVE_STATES.has(detail.state);
    return (
      <div className="max-w-3xl w-full mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
            <span className="flex items-center gap-1">
              <ChevronLeft width={14} height={14} />
              {t("analysis.back")}
            </span>
          </Button>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold truncate">
              {detail.title ?? detail.source}
            </h1>
            <p className="text-xs text-text/50 truncate">
              {detail.source_type === "url" ? detail.source : `file: ${detail.source}`}
              {detail.duration_s ? ` — ~${Math.round(detail.duration_s / 60)} min` : ""}
            </p>
          </div>
        </div>

        {active && (
          <ProgressBar
            percent={detail.progress?.percent ?? 0}
            label={`${t(`analysis.phases.${detail.progress?.phase ?? detail.state}`, { defaultValue: detail.state })}${detail.progress?.detail ? ` — ${detail.progress.detail}` : ""}`}
          />
        )}
        {detail.state === "error" && (
          <p className="text-sm text-red-400">Error: {detail.error}</p>
        )}

        {detail.analysis && (
          <>
            <div className="flex gap-2 border-b border-mid-gray/30">
              {(
                [
                  ["summary", t("analysis.tabs.summary")],
                  ["highlights", t("analysis.tabs.highlights", { count: detail.analysis.highlights.length })],
                  ["tasks", t("analysis.tabs.tasks", { count: detail.analysis.tasks.length })],
                  ["transcript", t("analysis.tabs.transcript")],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => (id === "transcript" ? openTranscript() : setTab(id))}
                  className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === id
                      ? "border-logo-primary text-logo-primary"
                      : "border-transparent text-text/60 hover:text-text"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "summary" && (
              <div className="text-sm whitespace-pre-wrap leading-relaxed">
                {detail.analysis.summary}
              </div>
            )}
            {tab === "highlights" && (
              <div className="space-y-3">
                {detail.analysis.highlights.map((h, i) => (
                  <div key={i} className="rounded-lg border border-mid-gray/20 p-3">
                    <p className="font-medium text-sm mb-1">{h.title}</p>
                    <p className="text-sm text-text/80 whitespace-pre-wrap">{h.summary}</p>
                  </div>
                ))}
              </div>
            )}
            {tab === "tasks" && (
              <div className="space-y-2">
                {detail.analysis.tasks.length === 0 && (
                  <p className="text-sm text-text/50">{t("analysis.tasks.none")}</p>
                )}
                {detail.analysis.tasks.map((task, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <ListChecks width={15} height={15} className="mt-0.5 text-logo-primary shrink-0" />
                    <span>
                      <b>{task.assignee}</b>: {task.task}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {tab === "transcript" && (
              <div className="space-y-3">
                {voices.length > 0 && (
                  <div className="rounded-lg border border-mid-gray/20 p-3 space-y-2">
                    <p className="text-xs text-text/60">
                      {t("analysis.speakers.hint", { n: voices.length })}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {voices.map((v) => (
                        <div key={v.label} className="flex items-center gap-1.5">
                          <span
                            className={`px-2 py-1 rounded border text-xs whitespace-nowrap ${colorOf(v.label)}`}
                          >
                            {v.shown}
                          </span>
                          <Input
                            className="w-40"
                            value={names[v.label] ?? ""}
                            onChange={(e) =>
                              setNames({ ...names, [v.label]: e.target.value })
                            }
                            placeholder={t("analysis.speakers.namePlaceholder")}
                            disabled={savingNames}
                          />
                        </div>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      onClick={saveNames}
                      disabled={savingNames || Object.keys(names).length === 0}
                    >
                      {t("analysis.speakers.save")}
                    </Button>
                  </div>
                )}
                <div className="space-y-2 max-h-[28rem] overflow-y-auto text-sm">
                  {!transcript && (
                    <p className="text-text/50">{t("analysis.transcript.loading")}</p>
                  )}
                  {transcript?.map((s, i) => {
                    const label = s.speaker_label ?? s.speaker;
                    return (
                      <div key={i} className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-text/40 tabular-nums">
                          {fmtTime(s.start_s)}
                        </span>
                        {label && (
                          <span
                            className={`px-1.5 py-0.5 rounded border text-xs whitespace-nowrap ${colorOf(label)}`}
                          >
                            {s.speaker ?? label}
                          </span>
                        )}
                        <span className="flex-1 min-w-0">{s.text}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="max-w-3xl w-full mx-auto space-y-5">
      <input
        ref={fileRef}
        type="file"
        accept=".mp4,.mkv,.webm,.avi,.mov,.m4v,.ts,.mp3,.wav,.m4a,.ogg,.flac,.aac,.opus,.wma"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) start("file", f);
        }}
      />
      <div>
        <h1 className="text-xl font-semibold mb-2 flex items-center gap-2">
          <ScanSearch width={20} height={20} className="text-logo-primary" />
          {t("analysis.title")}
        </h1>
        <p className="text-sm text-text/60">{t("analysis.subtitle")}</p>
      </div>

      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            className="flex-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("analysis.form.title")}
            disabled={busy}
          />
          <Input
            className="sm:w-52"
            type="number"
            min={0}
            max={20}
            inputMode="numeric"
            value={speakers}
            onChange={(e) => setSpeakers(e.target.value)}
            placeholder={t("analysis.form.speakers")}
            disabled={busy}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            className="flex-1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("analysis.form.url")}
            disabled={busy}
          />
          <Button onClick={() => start("url")} disabled={busy || !bridgeReachable}>
            <span className="flex items-center gap-1.5">
              <LinkIcon width={14} height={14} />
              {t("analysis.form.analyzeUrl")}
            </span>
          </Button>
          <Button
            variant="secondary"
            onClick={() => fileRef.current?.click()}
            disabled={busy || !bridgeReachable}
          >
            <span className="flex items-center gap-1.5">
              <Upload width={14} height={14} />
              {t("analysis.form.uploadFile")}
            </span>
          </Button>
        </div>
        {busy && <p className="text-xs text-text/50">{t("analysis.form.starting")}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-text/60">{t("analysis.history.title")}</h2>
        {items.length === 0 && (
          <p className="text-sm text-text/50">{t("analysis.history.empty")}</p>
        )}
        {items.map((it) => (
          <div
            key={it.id}
            className="rounded-lg border border-mid-gray/20 p-3 flex items-center gap-3 cursor-pointer hover:border-logo-primary transition-colors"
            onClick={() => open(it.id)}
          >
            {it.state === "done" ? (
              <CheckCircle2 width={16} height={16} className="text-green-500 shrink-0" />
            ) : it.state === "error" ? (
              <XCircle width={16} height={16} className="text-red-400 shrink-0" />
            ) : (
              <div className="w-4 h-4 border-2 border-logo-primary border-t-transparent rounded-full animate-spin shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{it.title ?? it.source}</p>
              <p className="text-xs text-text/50 truncate">
                {new Date(it.created).toLocaleString()} —{" "}
                {t(`analysis.phases.${it.state}`, { defaultValue: it.state })}
                {it.error ? `: ${it.error}` : ""}
              </p>
            </div>
            <Button
              variant="danger-ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(t("analysis.deleteConfirm"))) {
                  deleteAnalysis(it.id).then(refresh).catch(() => {});
                }
              }}
              aria-label={t("analysis.deleteLabel")}
            >
              <Trash2 width={14} height={14} />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
};
