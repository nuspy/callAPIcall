import React from "react";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
}

/** Select nativo con lo stile del design system (niente react-select). */
export const Select: React.FC<SelectProps> = ({
  value,
  onChange,
  options,
  disabled = false,
  className = "",
  placeholder,
  id,
  ariaLabel,
}) => {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`px-2 py-1.5 text-sm bg-background border border-mid-gray/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-logo-primary disabled:opacity-50 ${className}`}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
};
