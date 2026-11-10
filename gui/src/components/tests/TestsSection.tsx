import React, { useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  FlaskConical,
  Headphones,
  MessageSquareText,
  Phone,
  Volume2,
  Wrench,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { ALL_TESTS } from "@/lib/tests/definitions";
import type { TestDefinition, TestRunSummary } from "@/lib/tests/types";
import { GPU_PROFILES, NO_SIMULATION_ID, gpuProfileById } from "@/lib/tests/gpuProfiles";
import { describeProfile } from "@/lib/tests/gpuSim";
import { Select } from "../ui/Select";
import { TestWizard } from "./TestWizard";

const TEST_ICON: Record<string, React.ComponentType<any>> = {
  "half-duplex": Volume2,
  "full-duplex": Headphones,
  "acp-task": Wrench,
  "phone-call": Phone,
  copilot: MessageSquareText,
};

const STORAGE_KEY = "callapicall-test-results";
const GPU_SIM_KEY = "callapicall-gpu-sim-profile";

function loadResults(): Record<string, TestRunSummary> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveResult(summary: TestRunSummary) {
  const all = loadResults();
  all[summary.testId] = summary;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export const TestsSection: React.FC = () => {
  const { t } = useTranslation();
  const [active, setActive] = useState<TestDefinition | null>(null);
  const [results, setResults] = useState(loadResults);
  const [gpuSim, setGpuSim] = useState<string>(
    () => localStorage.getItem(GPU_SIM_KEY) ?? NO_SIMULATION_ID,
  );

  const changeGpuSim = (id: string) => {
    setGpuSim(id);
    localStorage.setItem(GPU_SIM_KEY, id);
  };

  if (active) {
    return (
      <TestWizard
        test={active}
        gpuSimId={gpuSim}
        onClose={(passed) => {
          if (passed !== null) {
            const summary: TestRunSummary = {
              testId: active.id,
              when: new Date().toISOString(),
              passed,
            };
            saveResult(summary);
            setResults(loadResults());
          }
          setActive(null);
        }}
      />
    );
  }

  return (
    <div className="max-w-3xl w-full mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-semibold mb-2 flex items-center gap-2">
          <FlaskConical width={20} height={20} className="text-logo-primary" />
          {t("tests.title")}
        </h1>
        <p className="text-sm text-text/60">{t("tests.subtitle")}</p>
      </div>

      <div className="rounded-lg border border-mid-gray/20 p-3 flex items-center gap-3">
        <span className="text-sm text-text/70 shrink-0">{t("tests.gpuSim")}:</span>
        <Select
          className="flex-1"
          value={gpuSim}
          onChange={changeGpuSim}
          options={GPU_PROFILES.map((p) => ({
            value: p.id,
            label:
              p.id === NO_SIMULATION_ID
                ? p.name
                : `${p.name} — ${describeProfile(p)}`,
          }))}
        />
      </div>
      {gpuSim !== NO_SIMULATION_ID && (
        <p className="text-xs text-text/50 -mt-2">
          {gpuProfileById(gpuSim).notes ?? ""}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3">
        {ALL_TESTS.map((test) => {
          const Icon = TEST_ICON[test.id] ?? FlaskConical;
          const last = results[test.id];
          return (
            <button
              key={test.id}
              type="button"
              onClick={() => setActive(test)}
              className="rounded-lg border border-mid-gray/20 p-4 text-left hover:border-logo-primary transition-colors cursor-pointer flex items-center gap-4"
            >
              <Icon width={22} height={22} className="text-logo-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm">{test.title}</p>
                <p className="text-xs text-text/60 truncate">{test.description}</p>
              </div>
              {last && (
                <span
                  className="flex items-center gap-1 text-xs shrink-0"
                  title={new Date(last.when).toLocaleString()}
                >
                  {last.passed ? (
                    <CheckCircle2 width={15} height={15} className="text-green-500" />
                  ) : (
                    <XCircle width={15} height={15} className="text-red-400" />
                  )}
                  <span className="text-text/50">
                    {new Date(last.when).toLocaleDateString()}
                  </span>
                </span>
              )}
              <ChevronRight width={16} height={16} className="text-text/30 shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
};
