'use client';

/** Filter chips: one pressed at a time, each a toggle button with `aria-pressed`. */
export function FilterChips<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; label: string }) {
  return (
    <span role="group" aria-label={label} style={{ display: 'contents' }}>
      {options.map((option) => (
        <button key={option.value} type="button" className="chip" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </span>
  );
}
