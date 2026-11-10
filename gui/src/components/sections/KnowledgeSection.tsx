import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  FileUp,
  FolderOpen,
  Globe,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { ProgressBar } from "../ui/ProgressBar";
import { KnowledgeLogin, KnowledgeSessionBar } from "./KnowledgeSession";
import { KnowledgeAccessTab, PageAclPanel } from "./KnowledgeAccess";
import {
  AuthProfile,
  ImportRecord,
  KnowledgeJob,
  KnowledgeProject,
  SearchHit,
  SkillRuntimeStatus,
  WikiTree,
  activateKnowledgeProject,
  createKnowledgeProject,
  deleteAuthProfile,
  drainCatalog,
  getAuthProfiles,
  getImports,
  getKnowledgeProjects,
  getKnowledgeSession,
  getSkillStatus,
  KnowledgeSession,
  knowledgeLogout,
  onKnowledgeSessionExpired,
  getWikiPage,
  getWikiTree,
  ingestDir,
  ingestFile,
  installSkill,
  knowledgeHealth,
  refreshWikiPage,
  saveAuthProfile,
  searchKnowledge,
  startImport,
  syncImport,
} from "@/lib/api/knowledgeApi";

type Tab = "import" | "docs" | "wiki" | "search" | "skill" | "access";

const SECTION_LABELS: Record<string, string> = {
  sources: "Sources",
  entities: "Entities",
  concepts: "Concepts",
  syntheses: "Syntheses",
  meetings: "Meetings",
};

const AUTH_FIELDS: Record<string, { key: string; label: string; secret?: boolean }[]> = {
  bearer: [{ key: "token", label: "Token", secret: true }],
  basic: [
    { key: "username", label: "Username / email" },
    { key: "password", label: "Password / API token", secret: true },
  ],
  header: [
    { key: "name", label: "Header name" },
    { key: "value", label: "Value", secret: true },
  ],
  cookie: [{ key: "cookies", label: "Cookie (k=v; ...) or cookies.txt path", secret: true }],
  oauth2: [
    { key: "token_url", label: "Token URL" },
    { key: "client_id", label: "Client ID" },
    { key: "client_secret", label: "Client secret", secret: true },
    { key: "refresh_token", label: "Refresh token", secret: true },
  ],
};

export const KnowledgeSection: React.FC = () => {
  const { t } = useTranslation();
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<KnowledgeProject[]>([]);
  const [project, setProject] = useState<string>("");
  const [newProject, setNewProject] = useState("");
  const [tab, setTab] = useState<Tab>("import");
  const [job, setJob] = useState<KnowledgeJob>({ running: false });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [depth, setDepth] = useState(1);
  const [scope, setScope] = useState("page");
  const [maxPages, setMaxPages] = useState(200);
  const [authProfile, setAuthProfile] = useState("");
  const [imports, setImports] = useState<ImportRecord[]>([]);

  const fileInput = useRef<HTMLInputElement>(null);
  const [dirPath, setDirPath] = useState("");

  const [tree, setTree] = useState<WikiTree>({});
  const [page, setPage] = useState<{ path: string; body: string; fm: Record<string, unknown> } | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);

  const [skillResults, setSkillResults] = useState<SkillRuntimeStatus[] | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);
  const [profiles, setProfiles] = useState<AuthProfile[]>([]);
  const [profName, setProfName] = useState("");
  const [profType, setProfType] = useState("bearer");
  const [profValues, setProfValues] = useState<Record<string, string>>({});

  // wikibridge multi-utente: null = sessione non ancora letta (o backend
  // call-bridge giù: si resta al comportamento single-user)
  const [session, setSession] = useState<KnowledgeSession | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const needsLogin = !!session?.multi_user && !session.logged_in;
  // gestione dei permessi: solo wikibridge multi-utente e solo admin
  const canManageAcl = !!session?.multi_user && !!session.logged_in && !!session.admin;

  const loadSession = useCallback(async () => {
    try {
      const s = await getKnowledgeSession();
      setSession(s);
      return s;
    } catch {
      setSession(null);
      return null;
    }
  }, []);

  const refreshBase = useCallback(async () => {
    try {
      const h = await knowledgeHealth();
      setReachable(true);
      setJob(h.job ?? { running: false }); // i non-admin non ricevono il job
      const projs = await getKnowledgeProjects();
      setProjects(projs);
      setProject((cur) => cur || h.active_project || projs[0]?.slug || "");
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    loadSession().then((s) => {
      if (!s?.multi_user || s.logged_in) refreshBase();
    });
  }, [loadSession, refreshBase]);

  // sessione rifiutata da wikibridge (scaduta, revocata, account disattivato)
  useEffect(
    () =>
      onKnowledgeSessionExpired(() => {
        setSessionExpired(true);
        loadSession();
      }),
    [loadSession],
  );

  // login SSO in corso nel browser: si controlla finché non si chiude
  useEffect(() => {
    if (!session?.sso_pending) return;
    const timer = setInterval(async () => {
      const s = await loadSession();
      if (s?.logged_in) {
        setSessionExpired(false);
        refreshBase();
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [session?.sso_pending, loadSession, refreshBase]);

  useEffect(() => {
    if (!reachable || needsLogin) return;
    const timer = setInterval(async () => {
      try {
        const h = await knowledgeHealth();
        setJob(h.job ?? { running: false });
        if (h.job.running && project) {
          const r = await getImports(project);
          setImports(r.imports);
        }
      } catch {
        setReachable(false);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [reachable, project, needsLogin]);

  const loadImports = useCallback(() => {
    if (!project) return;
    getImports(project).then((r) => setImports(r.imports)).catch(() => {});
  }, [project]);

  const loadTree = useCallback(() => {
    if (!project) return;
    getWikiTree(project).then((r) => setTree(r.tree)).catch(() => {});
  }, [project]);

  const loadProfiles = useCallback(() => {
    getAuthProfiles().then(setProfiles).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === "import") loadImports();
    if (tab === "import" || tab === "skill") loadProfiles();
    if (tab === "wiki") loadTree();
  }, [tab, loadImports, loadTree, loadProfiles]);

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (okMsg) setNotice(okMsg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (session && needsLogin) {
    return (
      <div className="w-full max-w-4xl space-y-4">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <BookOpen width={18} height={18} className="text-logo-primary" />
          {t("knowledge.title")}
        </h1>
        <KnowledgeLogin
          session={session}
          expired={sessionExpired}
          onSsoStarted={() => setSession((s) => (s ? { ...s, sso_pending: true, sso_error: null } : s))}
          onChange={(s) => {
            setSession(s);
            setSessionExpired(false);
            refreshBase();
          }}
        />
      </div>
    );
  }

  if (reachable === false) {
    return (
      <div className="max-w-2xl space-y-3">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <BookOpen width={18} height={18} className="text-logo-primary" />
          {t("knowledge.title")}
        </h1>
        <p className="text-sm text-text/70">{t("knowledge.serverDown")}</p>
        <pre className="text-xs bg-mid-gray/10 rounded p-3">
          cd C:\Projects\wikibridge{"\n"}py -3.12 -m venv .venv{"\n"}.venv\Scripts\pip install -e .
        </pre>
        <Button size="sm" onClick={refreshBase}>{t("knowledge.retry")}</Button>
      </div>
    );
  }

  const jobPercent =
    job.running && job.max_pages
      ? Math.min(100, (100 * (job.pages || 0)) / job.max_pages)
      : 0;

  return (
    <div className="max-w-4xl w-full space-y-4">
      <h1 className="text-lg font-semibold flex items-center gap-2">
        <BookOpen width={18} height={18} className="text-logo-primary" />
        {t("knowledge.title")}
      </h1>

      {session?.logged_in && (
        <KnowledgeSessionBar
          session={session}
          onLogout={() =>
            run(async () => {
              await knowledgeLogout();
              setSessionExpired(false);
              await loadSession();
            })
          }
        />
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-text/60">{t("knowledge.projectLabel")}</span>
        <select
          className="bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1.5 text-sm"
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            setPage(null);
            activateKnowledgeProject(e.target.value).catch(() => {});
          }}
        >
          {projects.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        <Input
          variant="compact"
          placeholder={t("knowledge.newProjectPlaceholder")}
          value={newProject}
          onChange={(e) => setNewProject(e.target.value)}
          className="w-44"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!newProject.trim()}
          onClick={() =>
            run(async () => {
              const p = await createKnowledgeProject(newProject.trim());
              setNewProject("");
              await refreshBase();
              setProject(p.slug);
            }, t("knowledge.projectCreated"))
          }
        >
          <span className="flex items-center gap-1">
            <Plus width={13} height={13} />
            {t("knowledge.createProject")}
          </span>
        </Button>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-mid-gray/20">
        {(
          [
            ["import", t("knowledge.tab.import"), Globe],
            ["docs", t("knowledge.tab.docs"), FileUp],
            ["wiki", t("knowledge.tab.wiki"), BookOpen],
            ["search", t("knowledge.tab.search"), Search],
            ["skill", t("knowledge.tab.skill"), KeyRound],
            ...(canManageAcl ? [["access", t("knowledge.access.tab"), ShieldCheck]] : []),
          ] as [Tab, string, React.ComponentType<any>][]
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            className={`px-3 py-2 text-sm flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${
              tab === id
                ? "border-logo-primary text-text"
                : "border-transparent text-text/70 hover:text-text"
            }`}
            onClick={() => setTab(id)}
          >
            <Icon width={14} height={14} />
            {label}
          </button>
        ))}
      </div>

      {job.running && (
        <div className="space-y-1">
          <ProgressBar
            percent={jobPercent}
            label={`${job.kind}: ${job.phase} — ${job.detail || ""}`}
            rightLabel={`${job.pages ?? 0}/${job.max_pages ?? "?"}`}
          />
        </div>
      )}
      {job.error && <p className="text-sm text-red-400">{t("knowledge.lastJobError", { msg: job.error })}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-green-500">{notice}</p>}

      {tab === "import" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
            <h2 className="text-sm font-medium text-text/60">
              {t("knowledge.import.title")}
            </h2>
            <Input
              placeholder={t("knowledge.import.urlPlaceholder")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div className="flex gap-3 flex-wrap items-end text-sm">
              <label className="flex flex-col gap-1 text-xs text-text/60">
                {t("knowledge.import.depthLabel")}
                <select
                  className="bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1.5 text-sm text-text"
                  value={depth}
                  onChange={(e) => setDepth(Number(e.target.value))}
                >
                  <option value={0}>{t("knowledge.import.depth0")}</option>
                  <option value={1}>{t("knowledge.import.depth1")}</option>
                  <option value={2}>{t("knowledge.import.depth2")}</option>
                  <option value={3}>{t("knowledge.import.depth3")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-text/60">
                {t("knowledge.import.scopeLabel")}
                <select
                  className="bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1.5 text-sm text-text"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="page">{t("knowledge.import.scopePage")}</option>
                  <option value="subtree">{t("knowledge.import.scopeSubtree")}</option>
                  <option value="space">{t("knowledge.import.scopeSpace")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-text/60">
                {t("knowledge.import.maxPagesLabel")}
                <Input
                  variant="compact"
                  type="number"
                  className="w-24"
                  value={maxPages}
                  onChange={(e) => setMaxPages(Number(e.target.value) || 200)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-text/60">
                {t("knowledge.import.authLabel")}
                <select
                  className="bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1.5 text-sm text-text"
                  value={authProfile}
                  onChange={(e) => setAuthProfile(e.target.value)}
                >
                  <option value="">{t("knowledge.import.authPublic")}</option>
                  {profiles.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name} ({p.type})
                    </option>
                  ))}
                </select>
              </label>
              <Button
                disabled={!url.trim() || job.running}
                onClick={() =>
                  run(
                    () =>
                      startImport({
                        project,
                        url: url.trim(),
                        depth,
                        scope,
                        max_pages: maxPages,
                        auth_profile: authProfile || null,
                      }),
                    t("knowledge.import.started"),
                  )
                }
              >
                {t("knowledge.import.importBtn")}
              </Button>
            </div>
            <p className="text-xs text-text/40">{t("knowledge.import.hint")}</p>
          </div>

          <div className="rounded-lg border border-mid-gray/20 p-4 space-y-2">
            <div className="flex items-center">
              <h2 className="text-sm font-medium text-text/60 flex-1">
                {t("knowledge.import.historyTitle")}
              </h2>
              <Button variant="ghost" size="sm" onClick={loadImports}>
                <RefreshCw width={13} height={13} />
              </Button>
            </div>
            {imports.length === 0 ? (
              <p className="text-xs text-text/50">{t("knowledge.import.empty")}</p>
            ) : (
              imports
                .slice()
                .reverse()
                .map((imp) => (
                  <div
                    key={imp.id}
                    className="flex items-center gap-2 text-sm border-t border-mid-gray/10 pt-2"
                  >
                    <span className="font-mono text-xs text-text/50">{imp.id}</span>
                    <span className="flex-1 truncate" title={imp.url}>
                      {imp.url}
                    </span>
                    <span className="text-xs text-text/50">
                      {imp.pages} pag.{imp.truncated ? ` ${t("knowledge.import.truncated")}` : ""}
                    </span>
                    <span
                      className={`text-xs ${
                        imp.state === "done"
                          ? "text-green-500"
                          : imp.state === "error"
                            ? "text-red-400"
                            : "text-yellow-400"
                      }`}
                    >
                      {imp.state}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      title={t("knowledge.import.syncTitle")}
                      disabled={job.running}
                      onClick={() =>
                        run(() => syncImport(project, imp.id), t("knowledge.import.syncStarted"))
                      }
                    >
                      <RefreshCw width={13} height={13} />
                    </Button>
                  </div>
                ))
            )}
          </div>
        </div>
      )}

      {tab === "docs" && (
        <div className="rounded-lg border border-mid-gray/20 p-4 space-y-4">
          <h2 className="text-sm font-medium text-text/60">
            {t("knowledge.docs.title")}
          </h2>
          <div className="flex items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  run(() => ingestFile(project, f), t("knowledge.docs.processing", { name: f.name }));
                e.target.value = "";
              }}
            />
            <Button
              disabled={job.running}
              onClick={() => fileInput.current?.click()}
            >
              <span className="flex items-center gap-1.5">
                <FileUp width={14} height={14} />
                {t("knowledge.docs.uploadFile")}
              </span>
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <FolderOpen width={16} height={16} className="text-text/50 shrink-0" />
            <Input
              variant="compact"
              placeholder={t("knowledge.docs.dirPlaceholder")}
              value={dirPath}
              onChange={(e) => setDirPath(e.target.value)}
              className="flex-1"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!dirPath.trim() || job.running}
              onClick={() =>
                run(() => ingestDir(project, dirPath.trim()), t("knowledge.docs.ingestStarted"))
              }
            >
              {t("knowledge.docs.importDir")}
            </Button>
          </div>
          <p className="text-xs text-text/40">{t("knowledge.docs.hint")}</p>
          <div className="border-t border-mid-gray/10 pt-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={job.running}
              onClick={() =>
                run(
                  () => drainCatalog(project),
                  t("knowledge.docs.drainDone"),
                )
              }
            >
              <span className="flex items-center gap-1.5">
                <Wrench width={13} height={13} />
                {t("knowledge.docs.drain")}
              </span>
            </Button>
            <p className="text-xs text-text/40 mt-1">{t("knowledge.docs.drainHint")}</p>
          </div>
        </div>
      )}

      {tab === "access" && canManageAcl && project && <KnowledgeAccessTab project={project} />}

      {tab === "wiki" && (
        <div className="flex flex-col md:flex-row gap-4">
          <div className="w-full md:w-72 shrink-0 rounded-lg border border-mid-gray/20 p-3 space-y-3 max-h-[40vh] md:max-h-[60vh] overflow-y-auto">
            {Object.entries(tree).map(([section, entries]) =>
              entries.length === 0 ? null : (
                <div key={section}>
                  <h3 className="text-xs font-semibold text-text/50 uppercase mb-1">
                    {SECTION_LABELS[section] || section}
                  </h3>
                  {entries.map((e) => (
                    <button
                      key={e.file}
                      className={`block w-full text-left text-sm px-2 py-1 rounded truncate ${
                        page?.path === e.file
                          ? "bg-logo-primary/20"
                          : "hover:bg-mid-gray/15"
                      }`}
                      title={e.title}
                      onClick={() =>
                        run(async () => {
                          const r = await getWikiPage(project, e.file);
                          setPage({ path: r.path, body: r.body, fm: r.frontmatter });
                        })
                      }
                    >
                      {e.title}
                    </button>
                  ))}
                </div>
              ),
            )}
            {Object.values(tree).every((v) => v.length === 0) && (
              <p className="text-xs text-text/50">{t("knowledge.wiki.empty")}</p>
            )}
          </div>
          <div className="flex-1 min-w-0 rounded-lg border border-mid-gray/20 p-4 md:max-h-[60vh] overflow-y-auto">
            {page ? (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-mono text-xs text-text/50 flex-1 break-all">
                    {page.path}
                  </span>
                  {typeof page.fm.url === "string" && page.fm.url && (
                    <Button
                      variant="secondary"
                      size="sm"
                      title={t("knowledge.wiki.refreshTitle")}
                      onClick={() =>
                        run(async () => {
                          const r = await refreshWikiPage(project, page.path);
                          setNotice(r.changed ? t("knowledge.wiki.updated") : t("knowledge.wiki.unchanged"));
                          const p2 = await getWikiPage(project, page.path);
                          setPage({ path: p2.path, body: p2.body, fm: p2.frontmatter });
                        })
                      }
                    >
                      <span className="flex items-center gap-1">
                        <RefreshCw width={13} height={13} />
                        {t("knowledge.wiki.refresh")}
                      </span>
                    </Button>
                  )}
                </div>
                {canManageAcl && /^(sources|meetings)\//.test(page.path) && (
                  <details className="mb-3 rounded-md border border-mid-gray/20">
                    <summary
                      className="flex items-center gap-2 min-h-[44px] px-3 cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary"
                    >
                      <ShieldCheck width={14} height={14} aria-hidden />
                      {t("knowledge.access.pageTitle")}
                    </summary>
                    <div className="px-3 pb-3">
                      <PageAclPanel project={project} path={page.path} />
                    </div>
                  </details>
                )}
                <pre className="text-sm whitespace-pre-wrap font-sans break-words">
                  {page.body}
                </pre>
              </>
            ) : (
              <p className="text-sm text-text/50">{t("knowledge.wiki.selectPage")}</p>
            )}
          </div>
        </div>
      )}

      {tab === "search" && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder={t("knowledge.search.placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && query.trim())
                  run(async () =>
                    setHits((await searchKnowledge(project, query.trim())).hits),
                  );
              }}
              className="flex-1"
            />
            <Button
              disabled={!query.trim()}
              onClick={() =>
                run(async () =>
                  setHits((await searchKnowledge(project, query.trim())).hits),
                )
              }
            >
              <Search width={14} height={14} />
            </Button>
          </div>
          {hits.map((h) => (
            <button
              key={h.path}
              className="block w-full text-left rounded-lg border border-mid-gray/20 p-3 hover:bg-mid-gray/10"
              onClick={() =>
                run(async () => {
                  const r = await getWikiPage(project, h.path);
                  setPage({ path: r.path, body: r.body, fm: r.frontmatter });
                  setTab("wiki");
                })
              }
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{h.title}</span>
                <span className="text-xs text-text/40">
                  {SECTION_LABELS[h.section] || h.section}
                </span>
              </div>
              <p
                className="text-xs text-text/60 mt-1"
                dangerouslySetInnerHTML={{
                  __html: h.snippet
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/\*\*(.+?)\*\*/g, "<mark>$1</mark>"),
                }}
              />
            </button>
          ))}
        </div>
      )}

      {tab === "skill" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
            <h2 className="text-sm font-medium text-text/60">
              {t("knowledge.skill.title")}
            </h2>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={skillBusy}
                onClick={() =>
                  run(async () => {
                    setSkillBusy(true);
                    try {
                      const r = await getSkillStatus();
                      setSkillResults(r.results || []);
                    } finally {
                      setSkillBusy(false);
                    }
                  })
                }
              >
                {skillBusy ? t("knowledge.skill.checking") : t("knowledge.skill.checkStatus")}
              </Button>
              <Button
                size="sm"
                disabled={skillBusy}
                onClick={() =>
                  run(async () => {
                    setSkillBusy(true);
                    try {
                      const r = await installSkill();
                      setSkillResults(r.results || []);
                    } finally {
                      setSkillBusy(false);
                    }
                  }, t("knowledge.skill.installDone"))
                }
              >
                {t("knowledge.skill.checkAndInstall")}
              </Button>
            </div>
            {skillResults?.map((r) => (
              <div key={r.runtime} className="flex items-center gap-2 text-sm">
                <span className="w-28 font-mono text-xs">{r.runtime}</span>
                <span
                  className={
                    r.status === "ok" || r.status === "installed"
                      ? "text-green-500"
                      : r.status === "skipped"
                        ? "text-text/50"
                        : "text-red-400"
                  }
                >
                  {r.status}
                </span>
                <span className="text-xs text-text/50 truncate" title={r.detail}>
                  {r.detail}
                </span>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
            <h2 className="text-sm font-medium text-text/60">
              {t("knowledge.skill.profilesTitle")}
            </h2>
            {profiles.map((p) => (
              <div key={p.name} className="flex items-center gap-2 text-sm">
                <span className="flex-1">
                  {p.name} <span className="text-xs text-text/40">({p.type})</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    run(async () => {
                      await deleteAuthProfile(p.name);
                      loadProfiles();
                    })
                  }
                >
                  <Trash2 width={13} height={13} />
                </Button>
              </div>
            ))}
            <div className="border-t border-mid-gray/10 pt-3 space-y-2">
              <div className="flex gap-2">
                <Input
                  variant="compact"
                  placeholder={t("knowledge.skill.profileNamePlaceholder")}
                  value={profName}
                  onChange={(e) => setProfName(e.target.value)}
                  className="w-40"
                />
                <select
                  className="bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1.5 text-sm"
                  value={profType}
                  onChange={(e) => {
                    setProfType(e.target.value);
                    setProfValues({});
                  }}
                >
                  {Object.keys(AUTH_FIELDS).map((tp) => (
                    <option key={tp} value={tp}>
                      {tp}
                    </option>
                  ))}
                </select>
              </div>
              {AUTH_FIELDS[profType].map((f) => (
                <Input
                  key={f.key}
                  variant="compact"
                  type={f.secret ? "password" : "text"}
                  placeholder={`${f.label} (or env:VAR)`}
                  value={profValues[f.key] ?? ""}
                  onChange={(e) =>
                    setProfValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                />
              ))}
              <Button
                size="sm"
                disabled={
                  !profName.trim() ||
                  AUTH_FIELDS[profType].some((f) => !(profValues[f.key] ?? "").trim())
                }
                onClick={() =>
                  run(async () => {
                    await saveAuthProfile(profName.trim(), {
                      type: profType,
                      ...profValues,
                    });
                    setProfName("");
                    setProfValues({});
                    loadProfiles();
                  }, t("knowledge.skill.profileSaved"))
                }
              >
                {t("knowledge.skill.saveProfile")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
