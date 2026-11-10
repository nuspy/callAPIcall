import React, { useEffect, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  ExternalLink,
  KeyRound,
  Loader2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import {
  calendarConnect,
  getCalendarStatus,
  getConfig,
  openExternal,
  putConfig,
} from "@/lib/api/bridgeApi";

type Provider = "google" | "microsoft";

// Struttura NON traducibile del wizard: url dei passi, chiavi di config e flag.
// I testi (titoli, righe, label dei link/campi) vivono nei dizionari i18n
// sotto `oauth.<provider>` e `oauth.fields.<key>`, letti a runtime con t().
interface FieldSchema {
  key: string;
  secret?: boolean;
}
interface StepSchema {
  url?: string;
  fields?: FieldSchema[];
  connect?: boolean;
}
const SCHEMA: Record<Provider, StepSchema[]> = {
  google: [
    { url: "https://console.cloud.google.com/projectcreate" },
    {
      url: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
    },
    { url: "https://console.cloud.google.com/apis/credentials/consent" },
    {
      url: "https://console.cloud.google.com/apis/credentials/oauthclient",
      fields: [
        { key: "calendar_google_client_id" },
        { key: "calendar_google_client_secret", secret: true },
      ],
    },
    { connect: true },
  ],
  microsoft: [
    {
      url: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    },
    {},
    {},
    {
      fields: [
        { key: "calendar_ms_client_id" },
        { key: "calendar_ms_tenant" },
      ],
    },
    { connect: true },
  ],
};

// Forma dei contenuti tradotti letti da `oauth.<provider>` (returnObjects).
interface WizardText {
  title: string;
  steps: { title: string; lines: string[]; link?: string }[];
}

interface OAuthSetupWizardProps {
  provider: Provider;
  onClose: (connected: boolean) => void;
}

export const OAuthSetupWizard: React.FC<OAuthSetupWizardProps> = ({
  provider,
  onClose,
}) => {
  const { t } = useTranslation();
  const schema = SCHEMA[provider];
  const content = t(`oauth.${provider}`, {
    returnObjects: true,
  }) as unknown as WizardText;
  const [stepIdx, setStepIdx] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [deviceCode, setDeviceCode] = useState<{ code: string; uri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stepSchema = schema[stepIdx];
  const stepText = content.steps[stepIdx];
  const isLast = stepIdx === schema.length - 1;

  useEffect(() => {
    getConfig()
      .then((r) => {
        const init: Record<string, string> = {};
        for (const s of schema) {
          for (const f of s.fields ?? []) {
            const v = r.config[f.key];
            if (typeof v === "string" && v) init[f.key] = v;
          }
        }
        setValues((prev) => ({ ...init, ...prev }));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!connecting || connected) return;
    const timer = setInterval(async () => {
      try {
        const st = await getCalendarStatus();
        const mine = st[provider];
        if (mine.connected) {
          setConnected(true);
          setConnecting(false);
        } else if (mine.flow_error) {
          setError(mine.flow_error);
          setConnecting(false);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }, [connecting, connected, provider]);

  const fieldsComplete = (s: StepSchema) =>
    (s.fields ?? []).every((f) => (values[f.key] ?? "").trim() !== ""
      || f.key === "calendar_ms_tenant");

  const next = async () => {
    setError(null);
    if (stepSchema.fields) {
      setSaving(true);
      try {
        const updates: Record<string, unknown> = {};
        for (const f of stepSchema.fields) {
          updates[f.key] = (values[f.key] ?? "").trim() ||
            (f.key === "calendar_ms_tenant" ? "common" : "");
        }
        await putConfig(updates);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    setStepIdx((i) => Math.min(i + 1, schema.length - 1));
  };

  const connect = async () => {
    setError(null);
    setConnecting(true);
    setDeviceCode(null);
    try {
      const r = await calendarConnect(provider);
      if (r.error) {
        setError(r.error);
        setConnecting(false);
      } else if (r.user_code && r.verification_uri) {
        setDeviceCode({ code: r.user_code, uri: r.verification_uri });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConnecting(false);
    }
  };

  return (
    <div className="max-w-2xl w-full mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => onClose(connected)}>
          <span className="flex items-center gap-1">
            <ChevronLeft width={14} height={14} />
            {connected ? t("oauth.wizard.done") : t("oauth.wizard.cancel")}
          </span>
        </Button>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <KeyRound width={18} height={18} className="text-logo-primary" />
          {content.title}
        </h1>
      </div>

      <div className="flex items-center gap-1.5">
        {content.steps.map((s, i) => (
          <React.Fragment key={i}>
            <button
              type="button"
              title={s.title}
              onClick={() => i < stepIdx && setStepIdx(i)}
              className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-medium transition-colors ${
                i < stepIdx
                  ? "bg-green-500/20 text-green-500 cursor-pointer"
                  : i === stepIdx
                    ? "bg-logo-primary text-white"
                    : "bg-mid-gray/15 text-text/40"
              }`}
            >
              {i < stepIdx ? <Check width={13} height={13} /> : i + 1}
            </button>
            {i < content.steps.length - 1 && (
              <div className={`flex-1 h-0.5 ${i < stepIdx ? "bg-green-500/40" : "bg-mid-gray/20"}`} />
            )}
          </React.Fragment>
        ))}
      </div>

      <div className="rounded-lg border border-mid-gray/20 p-5 space-y-3">
        <h2 className="font-medium">
          {t("oauth.wizard.step", { n: stepIdx + 1 })} {stepText.title}
        </h2>
        {stepText.lines.map((l, i) => (
          <p key={i} className="text-sm text-text/70">{l}</p>
        ))}

        {stepSchema.url && stepText.link && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openExternal(stepSchema.url!).catch(() => {})}
          >
            <span className="flex items-center gap-1.5">
              <ExternalLink width={13} height={13} />
              {stepText.link}
            </span>
          </Button>
        )}

        {stepSchema.fields?.map((f) => (
          <div key={f.key} className="space-y-1">
            <label className="text-xs text-text/60">
              {t(`oauth.fields.${f.key}.label`)}
            </label>
            <Input
              type={f.secret ? "password" : "text"}
              value={values[f.key] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.key]: e.target.value }))
              }
              placeholder={t(`oauth.fields.${f.key}.placeholder`)}
            />
          </div>
        ))}

        {stepSchema.connect && (
          <div className="space-y-3">
            {connected ? (
              <p className="text-sm text-green-500 flex items-center gap-2">
                <Check width={16} height={16} />
                {t("oauth.wizard.connected")}
              </p>
            ) : (
              <>
                <Button onClick={connect} disabled={connecting}>
                  <span className="flex items-center gap-1.5">
                    {connecting ? (
                      <Loader2 width={14} height={14} className="animate-spin" />
                    ) : (
                      <Circle width={10} height={10} fill="currentColor" />
                    )}
                    {connecting ? t("oauth.wizard.connecting") : t("oauth.wizard.connect")}
                  </span>
                </Button>
                {deviceCode && (
                  <div className="rounded bg-logo-primary/10 p-3 text-sm space-y-2">
                    <p>
                      {t("oauth.wizard.deviceCodeLabel")}{" "}
                      <b className="font-mono text-base">{deviceCode.code}</b>
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openExternal(deviceCode.uri).catch(() => {})}
                    >
                      <span className="flex items-center gap-1.5">
                        <ExternalLink width={13} height={13} />
                        {t("oauth.wizard.deviceCodeOpen", { uri: deviceCode.uri })}
                      </span>
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      <div className="flex justify-between">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
          disabled={stepIdx === 0}
        >
          <span className="flex items-center gap-1">
            <ChevronLeft width={13} height={13} />
            {t("oauth.wizard.back")}
          </span>
        </Button>
        {!isLast ? (
          <Button
            size="sm"
            onClick={next}
            disabled={saving || (stepSchema.fields ? !fieldsComplete(stepSchema) : false)}
          >
            <span className="flex items-center gap-1">
              {saving ? t("oauth.wizard.saving") : t("oauth.wizard.next")}
              <ChevronRight width={13} height={13} />
            </span>
          </Button>
        ) : (
          <Button size="sm" onClick={() => onClose(connected)} disabled={connecting}>
            {t("oauth.wizard.done")}
          </Button>
        )}
      </div>
    </div>
  );
};
