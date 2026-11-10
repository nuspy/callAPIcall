// Tipi dei test guidati: ogni test e' una sequenza di passi; i passi "auto"
// chiamano la diagnostica del backend, i passi "confirm" chiedono all'utente
// di verificare con i propri occhi/orecchie.

export interface TestStepResult {
  ok: boolean;
  detail?: string;
}

export interface TestContext {
  /** Input raccolti prima del run (es. numero di telefono da chiamare). */
  input: Record<string, string>;
  /** Aggiunge una riga al pannello di log del wizard. */
  log: (msg: string) => void;
}

export interface TestStep {
  id: string;
  title: string;
  /** Cosa fa il passo / cosa deve fare l'utente (mostrato mentre gira). */
  description: string;
  kind: "auto" | "confirm";
  /** Solo per kind=auto. */
  run?: (ctx: TestContext) => Promise<TestStepResult>;
  /** Solo per kind=confirm: domanda con risposta Sì/No. */
  confirmPrompt?: string;
  /** Modelli AI coinvolti (chiavi di MODEL_VRAM_GB): abilita la stima dei
   * tempi sulla GPU simulata per questo passo. */
  simModels?: string[];
}

export interface TestDefinition {
  id: string;
  title: string;
  description: string;
  /** Input richiesto prima di partire (es. numero per la telefonata). */
  needsInput?: { key: string; label: string; placeholder: string };
  steps: TestStep[];
}

export type StepState = "pending" | "running" | "pass" | "fail" | "skipped";

export interface TestRunSummary {
  testId: string;
  when: string; // ISO
  passed: boolean;
  failedStep?: string;
  /** Simulazione GPU attiva durante il run (id profilo + stime per passo). */
  gpuSimulation?: {
    profileId: string;
    steps: Record<string, { measuredMs: number; estimateMs: number }>;
  };
}
