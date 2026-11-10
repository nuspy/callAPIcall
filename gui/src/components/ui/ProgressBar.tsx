import React from "react";

interface ProgressBarProps {
  /** Percentuale 0-100. */
  percent: number;
  /** Etichetta sopra la barra (es. "Fase landmark — 120/480"). */
  label?: string;
  /** Etichetta a destra (es. "ETA ~2 min"). */
  rightLabel?: string;
  className?: string;
}

/** Barra di avanzamento a riempimento, stile design system. */
export const ProgressBar: React.FC<ProgressBarProps> = ({
  percent,
  label,
  rightLabel,
  className = "",
}) => {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className={`space-y-1 ${className}`}>
      {(label || rightLabel) && (
        <div className="flex justify-between text-xs text-text/60">
          <span className="truncate">{label}</span>
          {rightLabel && <span className="shrink-0 ms-2">{rightLabel}</span>}
        </div>
      )}
      <div className="h-2.5 w-full rounded-full bg-mid-gray/20 overflow-hidden">
        <div
          className="h-full bg-logo-primary rounded-full transition-[width] duration-300"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
};
