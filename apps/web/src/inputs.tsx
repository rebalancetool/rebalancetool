import { useState } from "react";
import { bpsToText, centsToText, parseDollarsToCents, parsePercentToBps } from "./parse.ts";

/**
 * Text inputs that hold integer solver units (cents / basis points) and only
 * deal in strings at the edge. While focused, the raw draft text is kept so
 * typing "12." isn't mangled; each valid draft is committed immediately, an
 * invalid draft marks the field and reverts to the last good value on blur.
 */

interface AmountInputProps {
  value: number;
  onValue: (value: number) => void;
  toText: (value: number) => string;
  parse: (text: string) => number | null;
  label: string;
  affix: "$" | "%";
  placeholder?: string;
}

function AmountInput({ value, onValue, toText, parse, label, affix, placeholder }: AmountInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? toText(value);
  const invalid = parse(text) === null;
  return (
    <span className={`amount-input${invalid ? " invalid" : ""}`}>
      {affix === "$" && <span aria-hidden="true">$</span>}
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        data-1p-ignore
        aria-label={label}
        aria-invalid={invalid || undefined}
        placeholder={placeholder ?? "0"}
        value={text}
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = parse(event.target.value);
          if (parsed !== null) onValue(parsed);
        }}
        onBlur={() => setDraft(null)}
      />
      {affix === "%" && <span aria-hidden="true">%</span>}
    </span>
  );
}

export function MoneyInput(props: { cents: number; onCents: (cents: number) => void; label: string }) {
  return (
    <AmountInput
      value={props.cents}
      onValue={props.onCents}
      toText={centsToText}
      parse={parseDollarsToCents}
      label={props.label}
      affix="$"
    />
  );
}

export function PercentInput(props: { bps: number; onBps: (bps: number) => void; label: string }) {
  return (
    <AmountInput
      value={props.bps}
      onValue={props.onBps}
      toText={bpsToText}
      parse={parsePercentToBps}
      label={props.label}
      affix="%"
    />
  );
}
