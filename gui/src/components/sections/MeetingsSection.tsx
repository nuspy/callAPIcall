import React, { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ListChecks,
  LogIn,
  LogOut,
  Settings2,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { OAuthSetupWizard } from "./OAuthSetupWizard";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useStatusStore } from "@/stores/statusStore";
import {
  type CalendarEvent,
  type CalendarStatus,
  type MeetbotStatus,
  type MeetingDetail,
  type MeetingItem,
  calendarConnect,
  deleteMeeting,
  getCalendarEvents,
  getCalendarStatus,
  getMeeting,
  getMeetingTranscript,
  getMeetingsList,
  getMeetbotStatus,
  meetbotJoin,
  meetbotLeave,
  meetingPushWiki,
  setEventAutojoin,
} from "@/lib/api/bridgeApi";
import {
  type KnowledgeProject,
  getProjectsIfRunning,
} from "@/lib/api/knowledgeApi";

type Tab = "summary" | "highlights" | "agreements" | "tasks" | "transcript";

export const MeetingsSection: React.FC = () => {
  const { t } = useTranslation();
  const bridgeReachable = useStatusStore((s) => s.bridgeReachable);
  const [bot, setBot] = useState<MeetbotStatus>({ state: "idle" });
  const [meetings, setMeetings] = useState<MeetingItem[]>([]);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [transcript, setTranscript] = useState<
    { ts: string; speaker: string; text: string }[] | null
  >(null);
  const [tab, setTab] = useState<Tab>("summary");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calStatus, setCalStatus] = useState<CalendarStatus | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [deviceCode, setDeviceCode] = useState<{ code: string; uri: string } | null>(null);
  const [wizardProvider, setWizardProvider] = useState<"google" | "microsoft" | null>(null);
  const [projects, setProjects] = useState<KnowledgeProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [pushingWiki, setPushingWiki] = useState(false);

  const botActive = ["joining", "waiting_admit", "in_call", "leaving"].includes(bot.state);
  const anyCalendar = calStatus?.google.connected || calStatus?.microsoft.connected;

  // Polling veloce: solo stato bot + lista riunioni (leggeri, backend locale).
  const refresh = useCallback(async () => {
    if (!bridgeReachable) return;
    try {
      setBot(await getMeetbotStatus());
    } catch {}
    try {
      setMeetings((await getMeetingsList()).meetings);
    } catch {}
  }, [bridgeReachable]);

  // Polling lento e SEPARATO per il calendario: getCalendarEvents ha timeout 30s
  // e interroga i provider esterni; a 3s le richieste si accumulerebbero.
  const refreshCalendar = useCallback(async () => {
    if (!bridgeReachable) return;
    try {
      const st = await getCalendarStatus();
      setCalStatus(st);
      if (st.google.connected || st.microsoft.connected) {
        setEvents((await getCalendarEvents(7)).events);
      }
    } catch {}
  }, [bridgeReachable]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    refreshCalendar();
    const timer = setInterval(refreshCalendar, 30000);
    return () => clearInterval(timer);
  }, [refreshCalendar]);

  // La vista dettaglio, aperta mentre l'analisi e' pending/analyzing, va
  // ri-pollata finche' non e' conclusa (done/error), altrimenti resta congelata.
  useEffect(() => {
    if (!detail || detail.analysis_state === "done" || detail.analysis_state === "error") {
      return;
    }
    const timer = setInterval(async () => {
      try {
        setDetail(await getMeeting(detail.id));
      } catch {}
    }, 3000);
    return () => clearInterval(timer);
  }, [detail?.id, detail?.analysis_state]);

  useEffect(() => {
    getProjectsIfRunning().then(setProjects).catch(() => setProjects([]));
  }, []);

  const join = async () => {
    if (!/^https?:\/\//.test(url.trim())) {
      setError(t("meetings.join.url"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await meetbotJoin(url.trim(), title || undefined, undefined,
                        projectId || undefined);
      setUrl("");
      setTitle("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    setBusy(true);
    try {
      await meetbotLeave();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string) => {
    setTranscript(null);
    setTab("summary");
    try {
      setDetail(await getMeeting(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openTranscript = async () => {
    setTab("transcript");
    if (!detail || transcript) return;
    try {
      setTranscript((await getMeetingTranscript(detail.id)).segments);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (wizardProvider) {
    return (
      <OAuthSetupWizard
        provider={wizardProvider}
        onClose={() => {
          setWizardProvider(null);
          refresh();
        }}
      />
    );
  }

  if (detail) {
    return (
      <div className="max-w-3xl w-full mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
            <span className="flex items-center gap-1">
              <ChevronLeft width={14} height={14} />
              {t("meetings.back")}
            </span>
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold truncate">{detail.title}</h1>
            <p className="text-xs text-text/50">
              {detail.created} — {t("meetings.participants", { n: detail.participants.length })}
              {detail.participants.length > 0 && `: ${detail.participants.join(", ")}`}
            </p>
          </div>
          {detail.analysis && (
            <div className="flex items-center gap-1.5">
              {!detail.project_id && (
                <select
                  className="bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1.5 text-xs"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">{t("meetings.projectSelect")}</option>
                  {projects.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={pushingWiki || (!detail.project_id && !projectId)}
                title={
                  detail.wiki_path
                    ? t("meetings.wikiTitleAlready", { path: detail.wiki_path })
                    : t("meetings.wikiTooltip")
                }
                onClick={async () => {
                  setPushingWiki(true);
                  setError(null);
                  try {
                    const r = await meetingPushWiki(
                      detail.id,
                      detail.project_id || projectId || undefined,
                    );
                    setDetail({ ...detail, wiki_path: r.wiki_path });
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setPushingWiki(false);
                  }
                }}
              >
                {pushingWiki
                  ? t("meetings.wikiPushing")
                  : detail.wiki_path
                    ? t("meetings.wikiPushRepublish")
                    : t("meetings.history.insertWiki")}
              </Button>
            </div>
          )}
        </div>

        {detail.analysis_state !== "done" && (
          <p className="text-sm text-amber-400">
            {t(`meetings.analysisState.${detail.analysis_state}`, { defaultValue: detail.analysis_state })}
            {detail.analysis_error ? `: ${detail.analysis_error}` : ""}
          </p>
        )}

        {detail.analysis && (
          <>
            <div className="flex gap-2 border-b border-mid-gray/30">
              {(
                [
                  ["summary", t("meetings.tab.summary")],
                  ["highlights", t("meetings.tab.highlights", { count: detail.analysis.highlights.length })],
                  ["agreements", t("meetings.tab.agreements", { count: detail.analysis.agreements?.length ?? 0 })],
                  ["tasks", t("meetings.tab.tasks", { count: detail.analysis.tasks.length })],
                  ["transcript", t("meetings.tab.transcript")],
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
            {tab === "agreements" && (
              <div className="space-y-2">
                {(detail.analysis.agreements ?? []).length === 0 && (
                  <p className="text-sm text-text/50">{t("meetings.noAgreements")}</p>
                )}
                {(detail.analysis.agreements ?? []).map((a, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 width={15} height={15} className="mt-0.5 text-green-500 shrink-0" />
                    <span>
                      <b>{a.title}</b>
                      {a.detail ? `: ${a.detail}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {tab === "tasks" && (
              <div className="space-y-2">
                {detail.analysis.tasks.length === 0 && (
                  <p className="text-sm text-text/50">{t("meetings.noTasks")}</p>
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
              <div className="space-y-1 max-h-[28rem] overflow-y-auto text-sm">
                {!transcript && <p className="text-text/50">{t("meetings.loadingTranscript")}</p>}
                {transcript?.map((s, i) => (
                  <p key={i}>
                    <span className="text-text/40 tabular-nums me-2">{s.ts}</span>
                    <b className="me-1">{s.speaker}:</b>
                    {s.text}
                  </p>
                ))}
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
      <div>
        <h1 className="text-xl font-semibold mb-2 flex items-center gap-2">
          <CalendarClock width={20} height={20} className="text-logo-primary" />
          {t("meetings.title")}
        </h1>
        <p className="text-sm text-text/60">{t("meetings.subtitle")}</p>
      </div>

      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        {botActive ? (
          <>
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full ${
                  bot.state === "in_call" ? "bg-green-500 animate-pulse" : "bg-amber-400 animate-pulse"
                }`}
              />
              <span className="text-sm font-medium">
                {t(`meetings.botState.${bot.state}`, { defaultValue: bot.state })} ({bot.platform ?? "?"})
              </span>
              <Button
                variant="danger"
                size="sm"
                className="ms-auto"
                onClick={leave}
                disabled={busy}
              >
                <span className="flex items-center gap-1.5">
                  <LogOut width={13} height={13} />
                  {t("meetings.leaveBtn")}
                </span>
              </Button>
            </div>
            {bot.participants && bot.participants.length > 0 && (
              <p className="text-xs text-text/60 flex items-center gap-1.5">
                <Users width={13} height={13} />
                {bot.participants.join(", ")}
              </p>
            )}
            <div className="space-y-1 max-h-44 overflow-y-auto text-sm border-t border-mid-gray/15 pt-2">
              {(bot.transcript_tail ?? []).map((s, i) => (
                <p key={i}>
                  <span className="text-text/40 tabular-nums me-2">{s.ts}</span>
                  <b className="me-1">{s.speaker}:</b>
                  {s.text}
                </p>
              ))}
              {(bot.transcript_tail ?? []).length === 0 && (
                <p className="text-text/40">{t("meetings.waitingSpeech")}</p>
              )}
            </div>
          </>
        ) : (
          <>
            <h2 className="text-sm font-medium text-text/60">{t("meetings.join.title")}</h2>
            <div className="flex gap-2">
              <Input
                className="flex-1"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("meetings.join.titlePlaceholder")}
                disabled={busy}
              />
              <select
                className="bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1.5 text-sm"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={busy}
                title={t("meetings.join.projectLabel")}
              >
                <option value="">{t("meetings.join.noProject")}</option>
                {projects.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {t("meetings.projectOption", { name: p.name })}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <Input
                className="flex-1"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("meetings.join.urlPlaceholder")}
                disabled={busy}
              />
              <Button onClick={join} disabled={busy || !bridgeReachable}>
                <span className="flex items-center gap-1.5">
                  <LogIn width={14} height={14} />
                  {t("meetings.join.join")}
                </span>
              </Button>
            </div>
            {bot.state === "error" && bot.error && (
              <p className="text-sm text-red-400">{t("meetings.lastError", { msg: bot.error })}</p>
            )}
          </>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-text/60 flex-1">
            {t("meetings.calendarTitle")}
          </h2>
          {(["google", "microsoft"] as const).map((prov) => {
            const st = calStatus?.[prov];
            return (
              <span key={prov} className="flex items-center gap-0.5">
                <Button
                  variant={st?.connected ? "secondary" : "primary-soft"}
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    if (!st?.configured) {
                      setWizardProvider(prov);
                      return;
                    }
                    try {
                      const r = await calendarConnect(prov);
                      if (r.error) setError(r.error);
                      else if (r.user_code && r.verification_uri) {
                        setDeviceCode({ code: r.user_code, uri: r.verification_uri });
                      }
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  {prov === "google" ? "Google" : "Outlook"}
                  {st?.connected ? " ✓" : ""}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setWizardProvider(prov)}
                >
                  <Settings2 width={14} height={14} />
                </Button>
              </span>
            );
          })}
        </div>

        {deviceCode && (
          <p className="text-sm rounded bg-logo-primary/10 p-2">
            {t("meetings.deviceCodePrompt", { uri: deviceCode.uri, code: deviceCode.code })}
            <Button variant="ghost" size="sm" className="ms-2" onClick={() => setDeviceCode(null)}>
              {t("meetings.deviceCodeClose")}
            </Button>
          </p>
        )}
        {calStatus?.google.flow_error && (
          <p className="text-xs text-red-400">Google: {calStatus.google.flow_error}</p>
        )}
        {calStatus?.microsoft.flow_error && (
          <p className="text-xs text-red-400">Outlook: {calStatus.microsoft.flow_error}</p>
        )}

        {!anyCalendar ? (
          <p className="text-xs text-text/50">{t("meetings.noCalendar")}</p>
        ) : events.length === 0 ? (
          <p className="text-xs text-text/50">{t("meetings.noEvents")}</p>
        ) : (
          <div className="space-y-1.5">
            {events.map((ev) => (
              <div key={ev.id} className="flex items-center gap-3 text-sm">
                <span className="text-text/40 tabular-nums shrink-0 w-28">
                  {ev.start ? new Date(ev.start).toLocaleString([], {
                    day: "2-digit", month: "2-digit",
                    hour: "2-digit", minute: "2-digit",
                  }) : "?"}
                </span>
                <span className="flex-1 truncate" title={ev.title}>
                  {ev.title}
                  <span className="text-text/40 text-xs ms-1">
                    ({ev.provider === "google" ? "G" : "O"})
                  </span>
                </span>
                {ev.meeting_url ? (
                  <>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer shrink-0">
                      <input
                        type="checkbox"
                        checked={ev.autojoin}
                        onChange={(e) => {
                          setEventAutojoin(ev.id, e.target.checked)
                            .then(refresh)
                            .catch(() => {});
                        }}
                      />
                      {t("meetings.autoJoin")}
                    </label>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={botActive || busy}
                      onClick={() => {
                        setUrl(ev.meeting_url!);
                        setTitle(ev.title);
                        meetbotJoin(ev.meeting_url!, ev.title)
                          .then(refresh)
                          .catch((e) => setError(e instanceof Error ? e.message : String(e)));
                      }}
                    >
                      {t("meetings.joinNow")}
                    </Button>
                  </>
                ) : (
                  <span className="text-xs text-text/40 shrink-0">{t("meetings.noLink")}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-text/60">{t("meetings.history.title")}</h2>
        {meetings.length === 0 && (
          <p className="text-sm text-text/50">{t("meetings.history.empty")}</p>
        )}
        {meetings.map((m) => (
          <div
            key={m.id}
            className="rounded-lg border border-mid-gray/20 p-3 flex items-center gap-3 cursor-pointer hover:border-logo-primary transition-colors"
            onClick={() => open(m.id)}
          >
            {m.analysis_state === "done" ? (
              <CheckCircle2 width={16} height={16} className="text-green-500 shrink-0" />
            ) : m.analysis_state === "error" ? (
              <XCircle width={16} height={16} className="text-red-400 shrink-0" />
            ) : (
              <div className="w-4 h-4 border-2 border-logo-primary border-t-transparent rounded-full animate-spin shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{m.title}</p>
              <p className="text-xs text-text/50 truncate">
                {m.created}
                {m.participants.length > 0 && ` — ${m.participants.join(", ")}`}
                {m.segments != null && ` — ${t("meetings.segments", { n: m.segments })}`}
                {" — "}
                {t(`meetings.analysisState.${m.analysis_state}`, { defaultValue: m.analysis_state })}
              </p>
            </div>
            <Button
              variant="danger-ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(t("meetings.history.deleteConfirm"))) {
                  deleteMeeting(m.id).then(refresh).catch(() => {});
                }
              }}
              aria-label={t("meetings.deleteLabel")}
            >
              <Trash2 width={14} height={14} />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
};
