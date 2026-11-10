import React, { useCallback, useEffect, useId, useState } from "react";
import {
  AlertTriangle,
  FolderTree,
  Pencil,
  Plus,
  ShieldCheck,
  ShieldOff,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { BridgeError } from "@/lib/api/bridgeApi";
import {
  AclCollection,
  AclInfo,
  AclLevel,
  AclPreview,
  KnowledgeSource,
  PrincipalsInput,
  deleteAclCollection,
  getAcl,
  getKnowledgeSources,
  setAclCollection,
  setAclEnforcement,
  setAclGate,
  setAclPage,
} from "@/lib/api/knowledgeApi";

// Gestione dei permessi di wikibridge (solo admin). Ogni modifica parte
// senza conferma: se allarga l'accesso il server risponde 409 con
// l'anteprima, che si mostra qui prima di confermare.

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary";
const TAP = `min-h-[44px] ${FOCUS}`;
const NOBODY = "acl:nessuno";
// rosso leggibile anche su fondo chiaro (danger-ghost usa red-400: ~2,8:1)
const DANGER_TEXT = "text-red-700 dark:text-red-400";
const SELECT =
  "min-h-[44px] bg-mid-gray/10 border border-mid-gray/30 rounded-md px-2 text-sm text-text " + FOCUS;

type Tr = ReturnType<typeof useTranslation>["t"];

function principalLabel(p: string, labels: Record<string, string>, t: Tr): string {
  if (labels[p]) return labels[p];
  if (p === NOBODY) return t("knowledge.access.nobody");
  if (p.startsWith("user:")) return t("knowledge.access.unknownPerson", { id: p.slice(5, 13) });
  return p;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Esegue una modifica; se allarga l'accesso restituisce l'anteprima da
 *  confermare invece di un errore. */
async function attempt(
  save: (confirm: boolean) => Promise<unknown>,
): Promise<AclPreview | null> {
  try {
    await save(false);
    return null;
  } catch (e) {
    if (e instanceof BridgeError && e.status === 409 && e.data?.preview) {
      return e.data.preview as AclPreview;
    }
    throw e;
  }
}

// --- anteprima delle modifiche che allargano ---------------------------------

const PreviewPanel: React.FC<{
  preview: AclPreview;
  labels: Record<string, string>;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ preview, labels, busy, onConfirm, onCancel }) => {
  const { t } = useTranslation();
  const lvl = (l: string | null | undefined) =>
    l ? t(`knowledge.session.levels.${l}`, l) : "—";
  const known = { ...labels, ...(preview.labels ?? {}) };
  const names = (ps?: string[]) => (ps || []).map((p) => principalLabel(p, known, t)).join(", ");
  // una collezione nuova non ha un livello "di partenza"
  const levelChanged =
    !!preview.classification?.[0] && preview.classification[0] !== preview.classification[1];
  // allarga senza aggiungere nessuno: è stata tolta una restrizione
  const restrictionLifted =
    !preview.added_principals?.length && !levelChanged && !preview.acl_enforcement &&
    !preview.removed_sources?.length;
  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-600/50 bg-amber-500/10 p-3 space-y-2 text-sm leading-relaxed"
    >
      <p className="flex items-start gap-2 font-semibold text-amber-800 dark:text-amber-300">
        <AlertTriangle width={16} height={16} className="shrink-0 mt-0.5" aria-hidden />
        {t("knowledge.access.widening", { count: preview.documents_affected })}
      </p>
      <ul className="space-y-1 ps-6 list-disc">
        {!!preview.added_principals?.length && (
          <li>{t("knowledge.access.gains", { who: names(preview.added_principals) })}</li>
        )}
        {!!preview.removed_principals?.length && (
          <li>{t("knowledge.access.removedFromList", { who: names(preview.removed_principals) })}</li>
        )}
        {!!preview.removed_sources?.length && (
          <li>{t("knowledge.access.sourcesLeave", { list: preview.removed_sources.join(", ") })}</li>
        )}
        {levelChanged && preview.classification && (
          <li>
            {t("knowledge.access.levelChange", {
              from: lvl(preview.classification[0]),
              to: lvl(preview.classification[1]),
            })}
          </li>
        )}
        {preview.acl_enforcement && !preview.acl_enforcement[1] && (
          <li>{t("knowledge.access.filterOffEffect")}</li>
        )}
        {restrictionLifted && <li>{t("knowledge.access.restrictionLifted")}</li>}
      </ul>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="danger" disabled={busy} onClick={onConfirm} className={TAP}>
          {t("knowledge.access.confirm")}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel} className={TAP}>
          {t("knowledge.access.cancel")}
        </Button>
      </div>
    </div>
  );
};

// --- editor di ruoli e persone ------------------------------------------------

export const PrincipalEditor: React.FC<{
  value: PrincipalsInput;
  onChange: (v: PrincipalsInput) => void;
  labels: Record<string, string>;
  knownRoles: string[];
  emptyText: string;
}> = ({ value, onChange, labels, knownRoles, emptyText }) => {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const listId = useId();
  const entry = text.trim();
  const add = (kind: "role" | "user") => {
    if (!entry) return;
    if (kind === "role" && !value.principals.includes(entry))
      onChange({ ...value, principals: [...value.principals, entry] });
    if (kind === "user" && !value.users.includes(entry))
      onChange({ ...value, users: [...value.users, entry] });
    setText("");
  };
  const chips = [
    ...value.principals.map((p) => ({ key: p, kind: "p" as const, person: p.startsWith("user:") })),
    ...value.users.map((u) => ({ key: u, kind: "u" as const, person: true })),
  ];
  return (
    <div className="space-y-2">
      {chips.length === 0 ? (
        <p className="text-sm text-text/70">{emptyText}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {chips.map((c) => {
            const label =
              c.kind === "u"
                ? t("knowledge.access.pendingUser", { name: c.key })
                : principalLabel(c.key, labels, t);
            const Icon = c.person ? User : Users;
            return (
              <li
                key={`${c.kind}:${c.key}`}
                className="flex items-center gap-1 rounded-full bg-mid-gray/20 ps-2.5 text-xs font-medium text-text/90"
              >
                <Icon width={12} height={12} aria-hidden />
                <span className="break-all">{label}</span>
                <button
                  type="button"
                  aria-label={t("knowledge.access.remove", { name: label })}
                  className={`flex items-center justify-center min-h-[44px] min-w-[44px] rounded-full hover:bg-mid-gray/20 ${FOCUS}`}
                  onClick={() =>
                    onChange(
                      c.kind === "u"
                        ? { ...value, users: value.users.filter((u) => u !== c.key) }
                        : { ...value, principals: value.principals.filter((p) => p !== c.key) },
                    )
                  }
                >
                  <X width={13} height={13} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label={t("knowledge.access.addLabel")}
          placeholder={t("knowledge.access.addPlaceholder")}
          list={listId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add("role");
            }
          }}
          className={`min-h-[44px] flex-1 min-w-0 basis-48 text-base ${FOCUS}`}
        />
        <datalist id={listId}>
          {knownRoles.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <Button variant="secondary" disabled={!entry} onClick={() => add("role")} className={TAP}>
          <span className="flex items-center gap-1.5">
            <Users width={14} height={14} aria-hidden />
            {t("knowledge.access.addRole")}
          </span>
        </Button>
        <Button variant="secondary" disabled={!entry} onClick={() => add("user")} className={TAP}>
          <span className="flex items-center gap-1.5">
            <User width={14} height={14} aria-hidden />
            {t("knowledge.access.addUser")}
          </span>
        </Button>
      </div>
    </div>
  );
};

const LevelSelect: React.FC<{
  value: AclLevel;
  levels: AclLevel[];
  onChange: (l: AclLevel) => void;
}> = ({ value, levels, onChange }) => {
  const { t } = useTranslation();
  return (
    <label className="flex flex-col gap-1.5 text-sm text-text/80">
      {t("knowledge.access.level")}
      <select className={SELECT} value={value} onChange={(e) => onChange(e.target.value as AclLevel)}>
        {levels.map((l) => (
          <option key={l} value={l}>
            {t(`knowledge.session.levels.${l}`, l)}
          </option>
        ))}
      </select>
    </label>
  );
};

// --- flusso "salva, eventualmente conferma" ------------------------------------

function useGuardedSave(onSaved: () => void) {
  const [preview, setPreview] = useState<AclPreview | null>(null);
  const [pending, setPending] = useState<((c: boolean) => Promise<unknown>) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (save: (confirm: boolean) => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      const p = await attempt(save);
      if (p) {
        setPreview(p);
        setPending(() => save);
      } else {
        onSaved();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await pending(true);
      setPreview(null);
      setPending(null);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    setPreview(null);
    setPending(null);
  };
  return { run, confirm, cancel, preview, busy, error };
}

const Card: React.FC<{ title: string; icon: React.ReactNode; children: React.ReactNode }> = ({
  title,
  icon,
  children,
}) => (
  <section className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
    <h2 className="text-sm font-semibold flex items-center gap-2">
      {icon}
      {title}
    </h2>
    {children}
  </section>
);

// --- scheda "Permessi" ----------------------------------------------------------

export const KnowledgeAccessTab: React.FC<{ project: string }> = ({ project }) => {
  const { t } = useTranslation();
  const [acl, setAcl] = useState<AclInfo | null>(null);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gate, setGate] = useState<PrincipalsInput>({ principals: [], users: [] });
  const [editing, setEditing] = useState<string | null>(null); // id o "" = nuova

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([getAcl(project), getKnowledgeSources(project)]);
      setAcl(a);
      setSources(s.sources);
      setGate({ principals: a.gate, users: [] });
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [project]);

  useEffect(() => {
    load();
  }, [load]);

  const enforcement = useGuardedSave(load);
  const gateSave = useGuardedSave(load);
  const removal = useGuardedSave(load);

  if (loadError) return <p role="alert" className="text-sm text-red-700 dark:text-red-400">{loadError}</p>;
  if (!acl) return <p className="text-sm text-text/70">{t("knowledge.access.loading")}</p>;

  const gateDirty =
    gate.users.length > 0 ||
    gate.principals.length !== acl.gate.length ||
    gate.principals.some((p) => !acl.gate.includes(p));

  return (
    <div className="space-y-4">
      <Card
        title={t("knowledge.access.filterTitle")}
        icon={
          acl.acl_enforcement ? (
            <ShieldCheck width={16} height={16} className="text-green-700 dark:text-green-400" aria-hidden />
          ) : (
            <ShieldOff width={16} height={16} className="text-amber-700 dark:text-amber-300" aria-hidden />
          )
        }
      >
        <p className="text-sm leading-relaxed">
          <strong>{acl.acl_enforcement ? t("knowledge.access.filterOn") : t("knowledge.access.filterOff")}</strong>{" "}
          <span className="text-text/70">
            {acl.acl_enforcement ? t("knowledge.access.filterOnHint") : t("knowledge.access.filterOffHint")}
          </span>
        </p>
        {enforcement.preview ? (
          <PreviewPanel
            preview={enforcement.preview}
            labels={acl.labels}
            busy={enforcement.busy}
            onConfirm={enforcement.confirm}
            onCancel={enforcement.cancel}
          />
        ) : (
          <Button
            variant={acl.acl_enforcement ? "secondary" : "primary"}
            disabled={enforcement.busy}
            onClick={() => enforcement.run((c) => setAclEnforcement(project, !acl.acl_enforcement, c))}
            className={`${TAP} ${acl.acl_enforcement ? DANGER_TEXT : ""}`}
          >
            {acl.acl_enforcement ? t("knowledge.access.turnOff") : t("knowledge.access.turnOn")}
          </Button>
        )}
        {enforcement.error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{enforcement.error}</p>}
      </Card>

      <Card title={t("knowledge.access.gateTitle")} icon={<Users width={16} height={16} aria-hidden />}>
        <p className="text-sm leading-relaxed text-text/70">{t("knowledge.access.gateHint")}</p>
        <PrincipalEditor
          value={gate}
          onChange={setGate}
          labels={acl.labels}
          knownRoles={acl.known_roles}
          emptyText={t("knowledge.access.gateEmpty")}
        />
        {gateSave.preview ? (
          <PreviewPanel
            preview={gateSave.preview}
            labels={acl.labels}
            busy={gateSave.busy}
            onConfirm={gateSave.confirm}
            onCancel={gateSave.cancel}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!gateDirty || gateSave.busy}
              onClick={() => gateSave.run((c) => setAclGate(project, gate, c))}
              className={TAP}
            >
              {t("knowledge.access.save")}
            </Button>
            {gateDirty && (
              <Button
                variant="ghost"
                onClick={() => setGate({ principals: acl.gate, users: [] })}
                className={TAP}
              >
                {t("knowledge.access.discard")}
              </Button>
            )}
          </div>
        )}
        {gateSave.error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{gateSave.error}</p>}
      </Card>

      <Card title={t("knowledge.access.collectionsTitle")} icon={<FolderTree width={16} height={16} aria-hidden />}>
        <p className="text-sm leading-relaxed text-text/70">{t("knowledge.access.collectionsHint")}</p>
        {Object.keys(acl.collections).length === 0 && editing === null && (
          <p className="text-sm text-text/70">{t("knowledge.access.noCollections")}</p>
        )}
        <ul className="space-y-3">
          {Object.entries(acl.collections).map(([id, coll]) =>
            editing === id ? (
              <li key={id}>
                <CollectionEditor
                  project={project}
                  id={id}
                  initial={coll}
                  acl={acl}
                  sources={sources}
                  onDone={() => {
                    setEditing(null);
                    load();
                  }}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li key={id} className="rounded-md border border-mid-gray/20 p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-sm break-all flex-1 min-w-0">{id}</span>
                  <span className="text-xs text-text/70">
                    {t(`knowledge.session.levels.${coll.classification}`, coll.classification)}
                  </span>
                  <Button variant="ghost" onClick={() => setEditing(id)} className={TAP}
                          aria-label={t("knowledge.access.editNamed", { name: id })}>
                    <Pencil width={14} height={14} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={removal.busy}
                    onClick={() => removal.run((c) => deleteAclCollection(project, id, c))}
                    className={`${TAP} ${DANGER_TEXT}`}
                    aria-label={t("knowledge.access.deleteNamed", { name: id })}
                  >
                    <Trash2 width={14} height={14} aria-hidden />
                  </Button>
                </div>
                <p className="text-xs text-text/70 break-words">
                  {t("knowledge.access.sourcesList", {
                    list: coll.sources.map((s) => sourceName(s, sources)).join(" · ") || "—",
                  })}
                </p>
                <p className="text-sm break-words">
                  {coll.principals.length
                    ? coll.principals.map((p) => principalLabel(p, acl.labels, t)).join(", ")
                    : t("knowledge.access.onlyAdmins")}
                </p>
              </li>
            ),
          )}
        </ul>
        {removal.preview && (
          <PreviewPanel
            preview={removal.preview}
            labels={acl.labels}
            busy={removal.busy}
            onConfirm={removal.confirm}
            onCancel={removal.cancel}
          />
        )}
        {removal.error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{removal.error}</p>}
        {editing === "" ? (
          <CollectionEditor
            project={project}
            id=""
            acl={acl}
            sources={sources}
            onDone={() => {
              setEditing(null);
              load();
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          editing === null && (
            <Button variant="secondary" onClick={() => setEditing("")} className={TAP}>
              <span className="flex items-center gap-1.5">
                <Plus width={14} height={14} aria-hidden />
                {t("knowledge.access.newCollection")}
              </span>
            </Button>
          )
        )}
      </Card>
      <p className="text-xs leading-relaxed text-text/70">{t("knowledge.access.pageHint")}</p>
    </div>
  );
};

function sourceName(id: string, sources: KnowledgeSource[]): string {
  const s = sources.find((x) => x.id === id);
  if (!s) return id;
  const target = Array.isArray(s.target) ? s.target.join(", ") : s.target;
  return `${id} — ${target}`;
}

const CollectionEditor: React.FC<{
  project: string;
  id: string;
  initial?: AclCollection;
  acl: AclInfo;
  sources: KnowledgeSource[];
  onDone: () => void;
  onCancel: () => void;
}> = ({ project, id, initial, acl, sources, onDone, onCancel }) => {
  const { t } = useTranslation();
  const [name, setName] = useState(id);
  const [who, setWho] = useState<PrincipalsInput>({
    principals: initial?.principals ?? [],
    users: [],
  });
  const [level, setLevel] = useState<AclLevel>(initial?.classification ?? "internal");
  const [picked, setPicked] = useState<string[]>(initial?.sources ?? []);
  const save = useGuardedSave(onDone);
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const owner = (sid: string) =>
    Object.entries(acl.collections).find(([cid, c]) => cid !== id && c.sources.includes(sid))?.[0];

  return (
    <form
      className="rounded-md border border-logo-primary/40 p-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.run((c) =>
          setAclCollection(project, slug, { ...who, classification: level, sources: picked }, c),
        );
      }}
    >
      {id === "" && (
        <label className="flex flex-col gap-1.5 text-sm text-text/80">
          {t("knowledge.access.collectionName")}
          <Input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`min-h-[44px] text-base ${FOCUS}`}
          />
        </label>
      )}
      <fieldset className="space-y-1">
        <legend className="text-sm text-text/80 mb-1">{t("knowledge.access.sourcesLegend")}</legend>
        {sources.length === 0 && <p className="text-sm text-text/70">{t("knowledge.access.noSources")}</p>}
        {sources.map((s) => {
          const taken = owner(s.id);
          return (
            <label
              key={s.id}
              className={`flex items-start gap-3 min-h-[44px] py-2 text-sm ${taken ? "opacity-60" : ""}`}
            >
              <input
                type="checkbox"
                className={`mt-0.5 h-5 w-5 shrink-0 ${FOCUS}`}
                disabled={!!taken}
                checked={picked.includes(s.id)}
                onChange={(e) =>
                  setPicked((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))
                }
              />
              <span className="min-w-0 break-words">
                {sourceName(s.id, sources)}
                {taken && (
                  <span className="block text-xs text-text/70">
                    {t("knowledge.access.inOther", { name: taken })}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="space-y-1.5">
        <p className="text-sm text-text/80">{t("knowledge.access.whoSees")}</p>
        <PrincipalEditor
          value={who}
          onChange={setWho}
          labels={acl.labels}
          knownRoles={acl.known_roles}
          emptyText={t("knowledge.access.onlyAdmins")}
        />
      </div>
      <LevelSelect value={level} levels={acl.levels} onChange={setLevel} />
      {save.preview ? (
        <PreviewPanel
          preview={save.preview}
          labels={acl.labels}
          busy={save.busy}
          onConfirm={save.confirm}
          onCancel={save.cancel}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!slug || save.busy} className={TAP}>
            {t("knowledge.access.save")}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} className={TAP}>
            {t("knowledge.access.cancel")}
          </Button>
        </div>
      )}
      {save.error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{save.error}</p>}
    </form>
  );
};

// --- permessi di un documento (vista Wiki) ------------------------------------

export const PageAclPanel: React.FC<{ project: string; path: string }> = ({ project, path }) => {
  const { t } = useTranslation();
  const [acl, setAcl] = useState<AclInfo | null>(null);
  const [who, setWho] = useState<PrincipalsInput>({ principals: [], users: [] });
  const [level, setLevel] = useState<AclLevel>("internal");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const a = await getAcl(project, path);
      setAcl(a);
      setWho({ principals: a.page?.acl_roles ?? [], users: [] });
      setLevel((a.page?.acl_classification as AclLevel) ?? "internal");
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [project, path]);

  useEffect(() => {
    setSaved(false);
    load();
  }, [load]);

  const save = useGuardedSave(() => {
    setSaved(true);
    load();
  });

  if (error) return <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>;
  if (!acl?.page) return null;
  const page = acl.page;
  const coll = page.collection ? acl.collections[page.collection] : null;

  return (
    <div className="space-y-3 text-sm">
      {coll && (
        <p className="leading-relaxed">
          {t("knowledge.access.pageCollection", { name: page.collection })}{" "}
          <span className="text-text/70">
            {coll.principals.map((p) => principalLabel(p, acl.labels, t)).join(", ") ||
              t("knowledge.access.onlyAdmins")}
          </span>
        </p>
      )}
      {page.acl_source_clauses.length > 0 && (
        <div className="space-y-1">
          <p>{t("knowledge.access.fromSource")}</p>
          <ul className="ps-5 list-disc text-text/80">
            {page.acl_source_clauses.map((c, i) => (
              <li key={i} className="break-words">
                {c.map((p) => principalLabel(p, acl.labels, t)).join(t("knowledge.access.or"))}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-1.5">
        <p>
          {coll || page.acl_source_clauses.length > 0
            ? t("knowledge.access.pageOwn")
            : t("knowledge.access.pageWho")}
        </p>
        <PrincipalEditor
          value={who}
          onChange={(v) => {
            setWho(v);
            setSaved(false);
          }}
          labels={acl.labels}
          knownRoles={acl.known_roles}
          emptyText={coll ? t("knowledge.access.pageOwnEmpty") : t("knowledge.access.onlyAdmins")}
        />
      </div>
      <LevelSelect
        value={level}
        levels={acl.levels}
        onChange={(l) => {
          setLevel(l);
          setSaved(false);
        }}
      />
      {save.preview ? (
        <PreviewPanel
          preview={save.preview}
          labels={acl.labels}
          busy={save.busy}
          onConfirm={save.confirm}
          onCancel={save.cancel}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={save.busy}
            onClick={() => save.run((c) => setAclPage(project, path, { ...who, classification: level }, c))}
            className={TAP}
          >
            {t("knowledge.access.save")}
          </Button>
          {saved && (
            <span role="status" className="text-sm text-green-700 dark:text-green-400">
              {t("knowledge.access.saved")}
            </span>
          )}
        </div>
      )}
      {save.error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{save.error}</p>}
    </div>
  );
};
