import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  CircleDashed,
  Loader2,
  MinusCircle,
  Play,
  X,
} from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import type { StepState, TestDefinition } from "@/lib/tests/types";
import { NO_SIMULATION_ID, gpuProfileById } from "@/lib/tests/gpuProfiles";
import { formatSimMs, simulate } from "@/lib/tests/gpuSim";

interface TestWizardProps {
  test: TestDefinition;
  /** Profilo GPU da simulare (NO_SIMULATION_ID = nessuna stima). */
  gpuSimId?: string;
  onClose: (passed: boolean | null) => void; // null = mai eseguito fino in fondo
}

interface StepUi {
  state: StepState;
  detail?: string;
}

const STEP_ICON: Record<StepState, React.ReactNode> = {
  pending: <CircleDashed width={16} height={16} className="text-text/30" />,
  running: <Loader2 width={16} height={16} className="animate-spin text-logo-primary" />,
  pass: <Check width={16} height={16} className="text-green-500" />,
  fail: <X width={16} height={16} className="text-red-400" />,
  skipped: <MinusCircle width={16} height={16} className="text-text/30" />,
};

/**
 * Runner generico dei test guidati: esegue i passi in sequenza, mostra lo
 * stato di ciascuno, raccoglie i log e chiede conferma all'utente nei passi
 * "confirm". Al primo fallimento i passi restanti vengono saltati.
 */
export const TestWizard: React.FC<TestWizardProps> = ({
  test,
  gpuSimId = NO_SIMULATION_ID,
  onClose,
}) => {
  const [steps, setSteps] = useState<StepUi[]>(
    test.steps.map(() => ({ state: "pending" })),
  );
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<null | boolean>(null);
  const [inputValue, setInputValue] = useState("");
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null);
  const confirmResolve = useRef<((v: boolean) => void) | null>(null);
  const abortRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const log = (msg: string) =>
    setLogs((l) => [...l, `${new Date().toLocaleTimeString()}  ${msg}`]);

  const setStep = (i: number, ui: StepUi) =>
    setSteps((s) => s.map((x, j) => (j === i ? ui : x)));

  const askConfirm = (i: number): Promise<boolean> =>
    new Promise((resolve) => {
      setConfirmIdx(i);
      confirmResolve.current = resolve;
    });

  const answerConfirm = (v: boolean) => {
    setConfirmIdx(null);
    confirmResolve.current?.(v);
    confirmResolve.current = null;
  };

  const start = async () => {
    if (test.needsInput && !inputValue.trim()) {
      log(`Inserisci prima: ${test.needsInput.label}`);
      return;
    }
    abortRef.current = false;
    setRunning(true);
    setFinished(null);
    setSteps(test.steps.map(() => ({ state: "pending" })));
    setLogs([]);
    const ctx = {
      input: test.needsInput ? { [test.needsInput.key]: inputValue } : {},
      log,
    };

    let passed = true;
    for (let i = 0; i < test.steps.length; i++) {
      if (abortRef.current || !passed) {
        setStep(i, { state: "skipped" });
        continue;
      }
      const step = test.steps[i];
      setStep(i, { state: "running" });
      log(`▶ ${step.title}`);
      try {
        if (step.kind === "confirm") {
          const yes = await askConfirm(i);
          setStep(i, {
            state: yes ? "pass" : "fail",
            detail: yes ? undefined : "esito negativo confermato dall'utente",
          });
          if (!yes) passed = false;
        } else {
          const t0 = performance.now();
          const res = await step.run!(ctx);
          const measuredMs = performance.now() - t0;
          setStep(i, { state: res.ok ? "pass" : "fail", detail: res.detail });
          if (res.detail) log(res.ok ? `✓ ${res.detail}` : `✗ ${res.detail}`);
          // Stima sulla GPU simulata (solo per i passi con carico AI noto).
          if (res.ok && gpuSimId !== NO_SIMULATION_ID && step.simModels?.length) {
            const sim = simulate(measuredMs, gpuSimId, step.simModels);
            if (sim) {
              const gpu = gpuProfileById(gpuSimId);
              if (!sim.feasible) {
                log(`⚠ su ${gpu.name}: NON eseguibile — ${sim.note}`);
              } else {
                log(
                  `≈ su ${gpu.name}: stima ${formatSimMs(sim.estimateMs)} ` +
                  `(misurato ${formatSimMs(measuredMs)}, ×${sim.factor.toFixed(1)}` +
                  `${sim.note ? `, ${sim.note}` : ""})`,
                );
              }
            }
          }
          if (!res.ok) passed = false;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStep(i, { state: "fail", detail: msg });
        log(`✗ errore: ${msg}`);
        passed = false;
      }
    }
    setRunning(false);
    setFinished(passed && !abortRef.current);
    log(passed ? "✅ Test superato." : "❌ Test fallito: vedi il passo in rosso.");
  };

  const currentConfirm =
    confirmIdx !== null ? test.steps[confirmIdx] : null;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => onClose(finished)}>
          <span className="flex items-center gap-1">
            <ChevronLeft width={14} height={14} />
            Indietro
          </span>
        </Button>
        <div>
          <h1 className="text-lg font-semibold">{test.title}</h1>
          <p className="text-xs text-text/60">{test.description}</p>
        </div>
        {gpuSimId !== NO_SIMULATION_ID && (
          <span className="ms-auto text-xs px-2 py-1 rounded-full bg-logo-primary/15 text-logo-primary shrink-0">
            sim: {gpuProfileById(gpuSimId).name}
          </span>
        )}
      </div>

      {test.needsInput && (
        <Input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={test.needsInput.placeholder}
          disabled={running}
        />
      )}

      <div className="flex gap-3">
        <Button onClick={start} disabled={running}>
          <span className="flex items-center gap-1.5">
            <Play width={13} height={13} fill="currentColor" />
            {running ? "In esecuzione..." : finished !== null ? "Riesegui" : "Avvia test"}
          </span>
        </Button>
        {running && (
          <Button
            variant="danger-ghost"
            onClick={() => {
              abortRef.current = true;
              answerConfirm(false);
            }}
          >
            Interrompi
          </Button>
        )}
        {finished !== null && (
          <span
            className={`self-center text-sm font-medium ${
              finished ? "text-green-500" : "text-red-400"
            }`}
          >
            {finished ? "Tutto funziona ✓" : "Qualcosa non va ✗"}
          </span>
        )}
      </div>

      {/* Passi */}
      <div className="rounded-lg border border-mid-gray/20 divide-y divide-mid-gray/10">
        {test.steps.map((step, i) => {
          const ui = steps[i];
          return (
            <div key={step.id} className="px-4 py-2.5 flex items-start gap-3">
              <span className="mt-0.5">{STEP_ICON[ui.state]}</span>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm font-medium ${
                    ui.state === "skipped" ? "text-text/40" : ""
                  }`}
                >
                  {i + 1}. {step.title}
                </p>
                {(ui.state === "running" || ui.state === "fail") && (
                  <p
                    className={`text-xs ${
                      ui.state === "fail" ? "text-red-400" : "text-text/60"
                    }`}
                  >
                    {ui.state === "fail" && ui.detail
                      ? ui.detail
                      : step.description}
                  </p>
                )}
                {ui.state === "pass" && ui.detail && (
                  <p className="text-xs text-text/50">{ui.detail}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Dialogo di conferma */}
      {currentConfirm && (
        <div className="rounded-lg border border-logo-primary/50 bg-logo-primary/10 p-4 space-y-3">
          <p className="text-sm font-medium">{currentConfirm.confirmPrompt}</p>
          <p className="text-xs text-text/60">{currentConfirm.description}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => answerConfirm(true)}>
              Sì, funziona
            </Button>
            <Button variant="danger" size="sm" onClick={() => answerConfirm(false)}>
              No
            </Button>
          </div>
        </div>
      )}

      {/* Log */}
      {logs.length > 0 && (
        <div
          ref={logRef}
          className="rounded-lg border border-mid-gray/20 bg-mid-gray/5 p-3 max-h-44 overflow-y-auto font-mono text-xs space-y-0.5"
        >
          {logs.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
      )}
    </div>
  );
};
