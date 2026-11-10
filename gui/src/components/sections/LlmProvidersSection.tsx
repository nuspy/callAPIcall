import React, { useCallback, useEffect, useState } from "react";
import { Check, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { useStatusStore } from "@/stores/statusStore";
import { getConfig, putConfig } from "@/lib/api/bridgeApi";
import {
  type LlmModel,
  type LlmProvider,
  type LlmRegistry,
  addLlmProvider,
  assignLlmProvider,
  getLlmModels,
  getLlmRegistry,
  removeLlmProvider,
  testLlmProvider,
  updateLlmProvider,
} from "@/lib/api/llmApi";

/**
 * Tab "LLM Providers": elenco a sinistra, dettaglio del provider scelto a
 * destra.
 *
 * Il provider decide CHI risponde (LM Studio in locale, Gemini, Claude, …); il
 * secondo dropdown, popolato su richiesta, decide con quale modello. Sui
 * provider locali i modelli già in memoria arrivano per primi e marcati: sono
 * quelli che non costano un caricamento.
 *
 * Le chiavi API non tornano mai dal bridge: il campo mostra un segnaposto
 * quando una chiave è salvata, e si riscrive solo per sostituirla.
 */
export const LlmProvidersSection: React.FC = () => {
  const { t } = useTranslation();
  const bridgeReachable = useStatusStore((s) => s.bridgeReachable);
  const [reg, setReg] = useState<LlmRegistry | null>(null);
  const [sel, setSel] = useState<string>("");
  const [models, setModels] = useState<LlmModel[]>([]);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [esito, setEsito] = useState<string | null>(null);
  const [nuovaChiave, setNuovaChiave] = useState("");
  const [aggiungiTipo, setAggiungiTipo] = useState("");
  // `copilot_force_external`: sta in config.json e non nel registro, perché è
  // un modo di funzionare del copilota, non una proprietà del provider.
  const [forceExternal, setForceExternal] = useState(false);

  const provider = reg?.providers.find((p) => p.id === sel) ?? null;
  // Chi conversa e chi vettorizza sono modelli DIVERSI: LM Studio li distingue
  // con `kind` ("embeddings" contro "llm"/"vlm"). Offrire l'una lista al posto
  // dell'altra porta a un LLM da 19 GB chiamato sulla /embeddings.
  const modelliChat = models.filter((m) => m.kind !== "embeddings");
  const modelliEmbed = models.filter((m) => m.kind === "embeddings");

  const refresh = useCallback(async () => {
    if (!bridgeReachable) return;
    try {
      const r = await getLlmRegistry();
      setReg(r);
      setSel((prev) => (r.providers.some((p) => p.id === prev)
        ? prev : r.providers[0]?.id ?? ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [bridgeReachable]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    getConfig()
      .then((c) => setForceExternal(Boolean(c.config.copilot_force_external)))
      .catch(() => {});
  }, []);

  // I modelli si chiedono quando serve — cioè quando si guarda quel provider —
  // non tutti insieme all'apertura: ogni provider remoto è una chiamata di rete.
  const caricaModelli = useCallback(async (id: string, refreshCache = false) => {
    if (!id) return;
    setLoadingModels(true);
    setModelsErr(null);
    try {
      const r = await getLlmModels(id, refreshCache);
      setModels(r.models ?? []);
      if (r.error) setModelsErr(r.error);
    } catch (e) {
      setModels([]);
      setModelsErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    setNuovaChiave("");
    setEsito(null);
    if (sel) caricaModelli(sel);
    else setModels([]);
  }, [sel, caricaModelli]);

  const run = async (label: string, fn: () => Promise<LlmRegistry | void>) => {
    setBusy(label);
    setError(null);
    try {
      const r = await fn();
      if (r) setReg(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const salvaCampo = (campi: Record<string, string>) =>
    run("save", async () => {
      const r = await updateLlmProvider(sel, campi);
      setReg(r);
    });

  const usatoDa = (id: string) =>
    Object.entries(reg?.assignments ?? {})
      .filter(([, v]) => v === id)
      .map(([k]) => k);

  const etichettaConsumatore = (c: string) =>
    t(`llm.consumer.${c}`, {
      defaultValue: c === "chat" ? "chat avatar (F4/F5)"
        : c === "copilot" ? "copilota (Shift+F4)"
        : c === "embed" ? "embedding / sapere persone" : c,
    });

  const statoProvider = (p: LlmProvider) => {
    if (p.local) return { icona: "●", classe: "text-green-400" };
    if (p.oauth_connected || p.has_key) return { icona: "●", classe: "text-green-400" };
    return { icona: "⚠", classe: "text-amber-400" };
  };

  return (
    <div className="max-w-5xl w-full mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-semibold mb-2">
          {t("llm.title", { defaultValue: "LLM Providers" })}
        </h1>
        <p className="text-sm text-text/60">
          {t("llm.subtitle", {
            defaultValue:
              "Chi risponde alle conversazioni: motori locali o servizi remoti. Il modello si sceglie qui, per provider.",
          })}
        </p>
      </div>

      {!bridgeReachable && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
          {t("llm.bridgeDown", { defaultValue: "Bridge non raggiungibile." })}
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4 items-start">
        {/* ELENCO */}
        <div className="w-full md:w-64 shrink-0 rounded-lg border border-mid-gray/20 p-2 space-y-1">
          <div className="flex gap-1">
            <Select
              className="flex-1"
              value={aggiungiTipo}
              onChange={setAggiungiTipo}
              placeholder={t("llm.addType", { defaultValue: "Aggiungi provider…" })}
              options={(reg?.types ?? []).map((ty) => ({ value: ty.type, label: ty.label }))}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!aggiungiTipo || busy !== null}
              onClick={() => run("add", async () => {
                const r = await addLlmProvider({ type: aggiungiTipo });
                setAggiungiTipo("");
                setReg(r);
                const nuovo = r.providers[r.providers.length - 1];
                if (nuovo) setSel(nuovo.id);
              })}
              aria-label={t("llm.add", { defaultValue: "Aggiungi" })}
            >
              <Plus width={14} height={14} />
            </Button>
          </div>
          <div className="pt-1 space-y-0.5">
            {(reg?.providers ?? []).map((p) => {
              const st = statoProvider(p);
              const usi = usatoDa(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSel(p.id)}
                  className={`w-full text-start min-h-[44px] px-2 py-1.5 rounded flex items-center gap-2 transition-colors ${
                    sel === p.id ? "bg-logo-primary/25" : "hover:bg-mid-gray/20"
                  }`}
                >
                  <span className={`${st.classe} shrink-0`}>{st.icona}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate">{p.name}</span>
                    <span className="block text-[11px] text-text/50 truncate">
                      {usi.length
                        ? usi.map(etichettaConsumatore).join(" · ")
                        : p.label}
                    </span>
                  </span>
                </button>
              );
            })}
            {reg?.providers.length === 0 && (
              <p className="text-xs text-text/50 p-2">
                {t("llm.empty", { defaultValue: "Nessun provider configurato." })}
              </p>
            )}
          </div>
        </div>

        {/* DETTAGLIO */}
        <div className="flex-1 w-full rounded-lg border border-mid-gray/20 p-4 space-y-3">
          {!provider ? (
            <p className="text-sm text-text/50">
              {t("llm.pick", { defaultValue: "Scegli un provider dall'elenco." })}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Input
                  className="flex-1 min-w-[10rem]"
                  value={provider.name}
                  onChange={(e) => setReg((r) => r && {
                    ...r,
                    providers: r.providers.map((x) =>
                      x.id === provider.id ? { ...x, name: e.target.value } : x),
                  })}
                  onBlur={(e) => salvaCampo({ name: e.target.value })}
                />
                <span className="text-xs text-text/50">{provider.label}</span>
              </div>

              {provider.note && (
                <p className="text-[11px] text-text/50 flex items-start gap-1.5">
                  <TriangleAlert width={12} height={12} className="mt-0.5 shrink-0" />
                  {provider.note}
                </p>
              )}

              {/* Endpoint: sui locali è modificabile, sui remoti è quello del servizio */}
              <div className="space-y-1">
                <label className="text-xs text-text/60">
                  {t("llm.baseUrl", { defaultValue: "Endpoint" })}
                </label>
                <Input
                  className="w-full font-mono text-xs"
                  value={provider.base_url}
                  onChange={(e) => setReg((r) => r && {
                    ...r,
                    providers: r.providers.map((x) =>
                      x.id === provider.id ? { ...x, base_url: e.target.value } : x),
                  })}
                  onBlur={(e) => salvaCampo({ base_url: e.target.value })}
                />
              </div>

              {/* Credenziali: la chiave salvata non torna mai dal bridge. */}
              {provider.auth !== "none" && (
                <div className="space-y-1">
                  <label className="text-xs text-text/60">
                    {t("llm.apiKey", { defaultValue: "API key" })}
                    {provider.has_key && (
                      <span className="ms-2 text-green-400">
                        {t("llm.keySaved", { defaultValue: "salvata" })}
                      </span>
                    )}
                  </label>
                  <div className="flex gap-2">
                    <Input
                      className="flex-1 font-mono text-xs"
                      type="password"
                      value={nuovaChiave}
                      onChange={(e) => setNuovaChiave(e.target.value)}
                      placeholder={provider.has_key
                        ? t("llm.keyReplace", { defaultValue: "•••• (scrivi per sostituirla)" })
                        : t("llm.keyEnter", { defaultValue: "incolla la chiave" })}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!nuovaChiave || busy !== null}
                      onClick={() => run("key", async () => {
                        const r = await updateLlmProvider(provider.id, { api_key: nuovaChiave });
                        setNuovaChiave("");
                        setReg(r);
                      })}
                    >
                      {t("common.save", { defaultValue: "Salva" })}
                    </Button>
                  </div>
                  {(provider.auth === "oauth" || provider.auth === "either") && (
                    <p className="text-[11px] text-text/40">
                      {provider.oauth_connected
                        ? t("llm.oauthOn", {
                            defaultValue: "OAuth collegato: {{account}}",
                            account: provider.oauth_account || "—" })
                        : t("llm.oauthSoon", {
                            defaultValue: "Accesso OAuth non ancora attivo: per ora usa una API key.",
                          })}
                    </p>
                  )}
                </div>
              )}

              {/* MODELLO: elenco chiesto al provider, i caldi per primi. */}
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-text/60 flex-1">
                    {t("llm.model", { defaultValue: "Modello" })}
                  </label>
                  <button
                    type="button"
                    className="text-xs text-text/60 hover:text-text flex items-center gap-1 min-h-[44px] px-2"
                    onClick={() => caricaModelli(provider.id, true)}
                    disabled={loadingModels}
                  >
                    <RefreshCw width={12} height={12}
                               className={loadingModels ? "animate-spin" : ""} />
                    {loadingModels
                      ? t("llm.loadingModels", { defaultValue: "carico…" })
                      : t("llm.reload", { defaultValue: "ricarica" })}
                  </button>
                </div>
                <Select
                  className="w-full"
                  value={provider.model}
                  onChange={(v) => salvaCampo({ model: v })}
                  disabled={loadingModels || modelliChat.length === 0}
                  placeholder={modelliChat.length
                    ? t("llm.pickModel", { defaultValue: "scegli un modello" })
                    : t("llm.noModels", { defaultValue: "nessun modello disponibile" })}
                  options={modelliChat.map((m) => ({
                    value: m.id,
                    label: m.loaded
                      ? `${m.label} — ${t("llm.inMemory", { defaultValue: "in memoria" })}`
                      : m.label,
                  }))}
                />
                {modelsErr && <p className="text-[11px] text-red-400">{modelsErr}</p>}
              </div>

              {/* Modello di embedding: campo SUO, perché chi vettorizza non è
                  chi conversa. Compare solo se questo provider serve il RAG. */}
              {reg?.assignments?.embed === provider.id && (
                <div className="space-y-1">
                  <label className="text-xs text-text/60">
                    {t("llm.embedModel", { defaultValue: "Modello di embedding" })}
                  </label>
                  <Select
                    className="w-full"
                    value={provider.embed_model ?? ""}
                    onChange={(v) => salvaCampo({ embed_model: v })}
                    disabled={loadingModels}
                    placeholder={t("llm.pickEmbed", {
                      defaultValue: "scegli il modello che vettorizza" })}
                    options={modelliEmbed.map((m) => ({ value: m.id, label: m.label }))}
                  />
                  <p className="text-[11px] text-text/40">
                    {t("llm.embedHint", {
                      defaultValue:
                        "Deve essere un modello di embedding, non uno di chat. Cambiandolo va rigenerato il sapere già indicizzato.",
                    })}
                  </p>
                </div>
              )}

              {/* A cosa serve questo provider */}
              <div className="space-y-1">
                <label className="text-xs text-text/60">
                  {t("llm.usedFor", { defaultValue: "Usa questo provider per" })}
                </label>
                <div className="flex flex-wrap gap-3">
                  {(reg?.consumers ?? []).map((c) => (
                    <label key={c} className="flex items-center gap-1.5 text-sm cursor-pointer select-none min-h-[44px]">
                      <input
                        type="checkbox"
                        className="accent-logo-primary"
                        checked={reg?.assignments?.[c] === provider.id}
                        onChange={(e) => run("assign", async () => {
                          const r = await assignLlmProvider(
                            c, e.target.checked ? provider.id : null);
                          setReg(r);
                        })}
                      />
                      {etichettaConsumatore(c)}
                    </label>
                  ))}
                </div>
                {/* Il copilota è locale PER POTER usare il RAG: il sapere delle
                    persone vive in casa e non viene spedito fuori. Questa è la
                    rinuncia esplicita, quando basta una conoscenza generica. */}
                {reg?.assignments?.copilot === provider.id && !provider.local && (
                  <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="accent-logo-primary mt-1"
                      checked={forceExternal}
                      onChange={(e) => {
                        setForceExternal(e.target.checked);
                        putConfig({ copilot_force_external: e.target.checked })
                          .catch((err) => setError(err instanceof Error ? err.message : String(err)));
                      }}
                    />
                    <span>
                      {t("llm.forceExternal", {
                        defaultValue: "Forza LLM esterna senza RAG" })}
                      <span className="block text-[11px] text-text/50">
                        {t("llm.forceExternalHint", {
                          defaultValue:
                            "Il copilota userà questo provider al posto dell'agente locale, rinunciando al sapere delle persone e agli strumenti. Richiede il riavvio del bridge.",
                        })}
                      </span>
                    </span>
                  </label>
                )}

                {/* I provider a sottoscrizione passano dal CLI ufficiale: sono
                    agenti completi, con secondi di latenza. Dirlo qui evita di
                    scoprirlo con l'avatar che tace per dieci secondi. */}
                {provider.realtime === false &&
                  reg?.assignments?.chat === provider.id && (
                  <p className="text-[11px] text-amber-400">
                    {t("llm.notRealtime", {
                      defaultValue:
                        "Attenzione: questo provider risponde in secondi (è il CLI ufficiale, un agente completo). Per la voce in tempo reale conviene un modello locale o una API key.",
                    })}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap pt-1">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => run("test", async () => {
                    const r = await testLlmProvider(provider.id);
                    setEsito(r.ok
                      ? t("llm.testOk", {
                          defaultValue: "Connesso: {{n}} modelli disponibili.",
                          n: r.models ?? 0 })
                      : t("llm.testKo", {
                          defaultValue: "Non raggiungibile: {{err}}",
                          err: r.error ?? "?" }));
                    await caricaModelli(provider.id, true);
                  })}
                >
                  {busy === "test"
                    ? t("llm.testing", { defaultValue: "provo…" })
                    : t("llm.test", { defaultValue: "Prova connessione" })}
                </Button>
                <Button
                  size="sm"
                  variant="danger-ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm(t("llm.removeConfirm", {
                      defaultValue: "Rimuovere il provider «{{name}}»?",
                      name: provider.name }))) {
                      run("del", async () => {
                        const r = await removeLlmProvider(provider.id);
                        setReg(r);
                        setSel(r.providers[0]?.id ?? "");
                      });
                    }
                  }}
                >
                  <span className="flex items-center gap-1">
                    <Trash2 width={13} height={13} />
                    {t("common.delete", { defaultValue: "Rimuovi" })}
                  </span>
                </Button>
                {esito && (
                  <span className="text-xs text-text/70 flex items-center gap-1">
                    <Check width={12} height={12} className="text-green-400" />
                    {esito}
                  </span>
                )}
              </div>
            </>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
};
