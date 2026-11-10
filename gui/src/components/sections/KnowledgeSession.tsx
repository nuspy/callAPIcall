import React, { useState } from "react";
import { Loader2, LockKeyhole, LogOut, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import {
  KnowledgeSession,
  knowledgeLogin,
  knowledgeLoginSso,
} from "@/lib/api/knowledgeApi";

// wikibridge multi-utente: quello che si vede (e quello che riceve l'LLM)
// dipende da chi è collegato. Il login e la barra "vedi come" rendono
// esplicito questo filtro.

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary";
const VISIBLE_ROLES = 4;

interface LoginProps {
  session: KnowledgeSession;
  expired: boolean;
  onChange: (s: KnowledgeSession) => void;
  onSsoStarted: () => void;
}

export const KnowledgeLogin: React.FC<LoginProps> = ({
  session,
  expired,
  onChange,
  onSsoStarted,
}) => {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sso = session.login === "sso";
  const waiting = busy || !!session.sso_pending;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (sso) {
        await knowledgeLoginSso();
        onSsoStarted();
      } else {
        const s = await knowledgeLogin(username.trim(), password);
        setPassword("");
        onChange(s);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const message =
    error ||
    (session.sso_error ? t("knowledge.session.ssoFailed", { msg: session.sso_error }) : null);

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-md rounded-xl border border-mid-gray/20 p-4 sm:p-6 space-y-4"
      aria-labelledby="kb-login-title"
    >
      <div className="flex items-start gap-3">
        <LockKeyhole width={22} height={22} className="text-logo-primary shrink-0 mt-0.5" aria-hidden />
        <div className="space-y-1">
          <h2 id="kb-login-title" className="text-base font-semibold">
            {t("knowledge.session.title")}
          </h2>
          <p className="text-sm leading-relaxed text-text/70">{t("knowledge.session.intro")}</p>
        </div>
      </div>

      {expired && !message && (
        <p role="status" className="text-sm leading-relaxed text-amber-700 dark:text-amber-300">
          {t("knowledge.session.expired")}
        </p>
      )}

      {!sso && (
        <div className="space-y-3">
          <label className="flex flex-col gap-1.5 text-sm text-text/80">
            {t("knowledge.session.username")}
            <Input
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={`min-h-12 text-base ${FOCUS}`}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-text/80">
            {t("knowledge.session.password")}
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`min-h-12 text-base ${FOCUS}`}
            />
          </label>
        </div>
      )}

      {waiting && sso && (
        <p role="status" className="flex items-start gap-2 text-sm leading-relaxed text-text/80">
          <Loader2 width={16} height={16} className="shrink-0 mt-0.5 motion-safe:animate-spin" aria-hidden />
          {t("knowledge.session.ssoWaiting")}
        </p>
      )}

      {message && (
        <p role="alert" className="text-sm leading-relaxed text-red-700 dark:text-red-400 break-words">
          {message}
        </p>
      )}

      <Button
        type="submit"
        size="lg"
        disabled={waiting || (!sso && (!username.trim() || !password))}
        className={`w-full min-h-12 ${FOCUS}`}
      >
        <span className="flex items-center justify-center gap-2">
          {waiting && !sso && (
            <Loader2 width={16} height={16} className="motion-safe:animate-spin" aria-hidden />
          )}
          {waiting && !sso
            ? t("knowledge.session.signingIn")
            : sso
              ? t("knowledge.session.sso")
              : t("knowledge.session.submit")}
        </span>
      </Button>
    </form>
  );
};

interface BarProps {
  session: KnowledgeSession;
  onLogout: () => void;
}

/** "Vedi la conoscenza come": chi è collegato e con quali ruoli, sempre
 *  visibile sopra i contenuti filtrati. */
export const KnowledgeSessionBar: React.FC<BarProps> = ({ session, onLogout }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // il principal personale (user:...) non è un ruolo che l'utente riconosce
  const roles = (session.roles || []).filter((r) => !r.startsWith("user:") && r !== "admin");
  const shown = expanded ? roles : roles.slice(0, VISIBLE_ROLES);
  const hidden = roles.length - shown.length;

  return (
    <section
      aria-label={t("knowledge.session.viewingAs")}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-logo-primary/40 bg-logo-primary/10 px-3 py-2"
    >
      <ShieldCheck width={18} height={18} className="text-logo-primary shrink-0" aria-hidden />
      <p className="text-sm min-w-0 flex-1 basis-48">
        <span className="text-text/60">{t("knowledge.session.viewingAs")} </span>
        <strong className="font-semibold break-words">{session.display_name}</strong>
        {session.clearance && (
          <span className="text-text/60">
            {" · "}
            {t("knowledge.session.clearance", {
              level: t(`knowledge.session.levels.${session.clearance}`, session.clearance),
            })}
          </span>
        )}
      </p>
      <ul className="flex flex-wrap items-center gap-1.5" aria-label={t("knowledge.session.rolesLabel")}>
        {session.admin && (
          <li className="rounded-full bg-background-ui px-2.5 py-1 text-xs font-medium text-white">
            {t("knowledge.session.admin")}
          </li>
        )}
        {shown.map((r) => (
          <li key={r} className="rounded-full bg-mid-gray/20 px-2.5 py-1 text-xs font-medium text-text/80 break-all">
            {r}
          </li>
        ))}
        {roles.length === 0 && !session.admin && (
          <li className="text-xs text-text/60">{t("knowledge.session.noRoles")}</li>
        )}
        {(hidden > 0 || expanded) && roles.length > VISIBLE_ROLES && (
          <li>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className={`min-h-[44px] min-w-[44px] rounded-full px-3 text-xs font-medium text-text underline underline-offset-2 ${FOCUS}`}
            >
              {expanded
                ? t("knowledge.session.fewerRoles")
                : t("knowledge.session.moreRoles", { count: hidden })}
            </button>
          </li>
        )}
      </ul>
      <Button variant="ghost" onClick={onLogout} className={`min-h-[44px] ${FOCUS}`}>
        <span className="flex items-center gap-1.5">
          <LogOut width={15} height={15} aria-hidden />
          {t("knowledge.session.logout")}
        </span>
      </Button>
    </section>
  );
};
