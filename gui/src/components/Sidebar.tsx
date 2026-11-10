import React from "react";
import {
  Activity,
  AudioLines,
  BrainCircuit,
  BookOpen,
  CalendarClock,
  Cog,
  FlaskConical,
  Mic,
  Phone,
  ScanSearch,
  ServerCog,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStatusStore } from "@/stores/statusStore";
import { LanguageSelector } from "./LanguageSelector";
import { SessionSection } from "./sections/SessionSection";
import { CallsSection } from "./sections/CallsSection";
import { ComponentsSection } from "./sections/ComponentsSection";
import { SettingsSection } from "./sections/SettingsSection";
import { VoiceEngineSection } from "./sections/VoiceEngineSection";
import { LlmProvidersSection } from "./sections/LlmProvidersSection";
import { VoicesSection } from "./sections/VoicesSection";
import { PersonasSection } from "./sections/PersonasSection";
import { AnalysisSection } from "./sections/AnalysisSection";
import { KnowledgeSection } from "./sections/KnowledgeSection";
import { MeetingsSection } from "./sections/MeetingsSection";
import { TestsSection } from "./tests/TestsSection";

export type SidebarSection = keyof typeof SECTIONS_CONFIG;

interface IconProps {
  width?: number | string;
  height?: number | string;
  className?: string;
  [key: string]: any;
}

interface SectionConfig {
  /** Chiave i18n del nome sezione (namespace "sidebar"). */
  labelKey: string;
  icon: React.ComponentType<IconProps>;
  component: React.ComponentType;
}

export const SECTIONS_CONFIG = {
  session: { labelKey: "sidebar.session", icon: Mic, component: SessionSection },
  calls: { labelKey: "sidebar.calls", icon: Phone, component: CallsSection },
  components: { labelKey: "sidebar.components", icon: Activity, component: ComponentsSection },
  tests: { labelKey: "sidebar.tests", icon: FlaskConical, component: TestsSection },
  voices: { labelKey: "sidebar.voices", icon: AudioLines, component: VoicesSection },
  // Niente sezione "Studio": il banco di prova dell'avatar si apre dalla riga
  // della persona (TtsStudioDialog), che è la sola identità su cui abbia senso.
  personas: { labelKey: "sidebar.personas", icon: Users, component: PersonasSection },
  meetings: { labelKey: "sidebar.meetings", icon: CalendarClock, component: MeetingsSection },
  knowledge: { labelKey: "sidebar.knowledge", icon: BookOpen, component: KnowledgeSection },
  analysis: { labelKey: "sidebar.analysis", icon: ScanSearch, component: AnalysisSection },
  voiceEngine: { labelKey: "sidebar.voiceEngine", icon: ServerCog, component: VoiceEngineSection },
  llmProviders: { labelKey: "sidebar.llmProviders", icon: BrainCircuit, component: LlmProvidersSection },
  settings: { labelKey: "sidebar.settings", icon: Cog, component: SettingsSection },
} as const satisfies Record<string, SectionConfig>;

interface SidebarProps {
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSectionChange,
}) => {
  const { t } = useTranslation();
  const bridgeReachable = useStatusStore((s) => s.bridgeReachable);

  return (
    <div className="flex flex-col w-44 h-full border-e border-mid-gray/20 items-center px-2 shrink-0">
      <div className="flex items-center gap-2 m-4">
        <Phone width={22} height={22} className="text-logo-primary" />
        <span className="font-semibold text-sm leading-tight">
          {t("app.title")}
          <br />
          <span className="text-xs font-normal text-text/60">{t("app.subtitle")}</span>
        </span>
      </div>

      <div
        className={`flex items-center gap-1.5 text-xs mb-2 ${
          bridgeReachable ? "text-green-500" : "text-red-400"
        }`}
        title={bridgeReachable ? t("status.serverReachable") : t("status.serverDown")}
      >
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            bridgeReachable ? "bg-green-500" : "bg-red-400"
          }`}
        />
        {bridgeReachable ? t("status.connected") : t("status.disconnected")}
      </div>

      <div className="flex flex-col w-full items-center gap-1 pt-2 border-t border-mid-gray/20 overflow-y-auto flex-1">
        {(Object.entries(SECTIONS_CONFIG) as [SidebarSection, SectionConfig][]).map(
          ([id, section]) => {
            const Icon = section.icon;
            const isActive = activeSection === id;
            const label = t(section.labelKey);
            return (
              <div
                key={id}
                className={`flex gap-2 items-center p-2 w-full rounded-lg cursor-pointer transition-colors ${
                  isActive
                    ? "bg-logo-primary/80"
                    : "hover:bg-mid-gray/20 hover:opacity-100 opacity-85"
                }`}
                onClick={() => onSectionChange(id)}
              >
                <Icon width={20} height={20} className="shrink-0" />
                <p className="text-sm font-medium truncate" title={label}>
                  {label}
                </p>
              </div>
            );
          },
        )}
      </div>

      {/* Selettore lingua: sotto le sezioni, persistente tra sessioni. */}
      <div className="w-full pt-2 border-t border-mid-gray/20 mt-1 mb-2">
        <LanguageSelector />
      </div>
    </div>
  );
};
