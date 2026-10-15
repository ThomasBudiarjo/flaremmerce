import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { number, parseWholeNumber } from "@/lib/format";

const same = (a: number | null, b: number | null) => a === b || (Number.isNaN(a) && Number.isNaN(b));
const show = (value: number | null) => (value == null || Number.isNaN(value) ? "" : String(value));

/**
 * Text input state for a whole number. The typed text is kept as is ("150.000"), the parsed value is
 * reported on every change, and NaN means the text is not a whole number. An invalid or out-of-range value
 * sets the input's custom validity, so the browser refuses to submit its form.
 */
export function useWholeNumber(value: number | null, onValueChange: (value: number | null) => void, { min, max }: { min?: number; max?: number } = {}) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => show(value));
  const [seen, setSeen] = useState(value);
  // A change from outside (discard, reset, server rebase) replaces the text; the admin's own edit keeps its formatting.
  if (!same(value, seen)) {
    setSeen(value);
    if (!same(value, parseWholeNumber(text))) setText(show(value));
  }
  const parsed = parseWholeNumber(text);
  const error = Number.isNaN(parsed)
    ? "Isi angka bulat. Pemisah ribuan memakai titik, mis. 150.000"
    : parsed != null && min != null && parsed < min
      ? `Minimal ${number(min)}`
      : parsed != null && max != null && parsed > max
        ? `Maksimal ${number(max)}`
        : "";
  useEffect(() => ref.current?.setCustomValidity(error), [error]);
  return {
    error,
    inputProps: {
      ref,
      type: "text",
      inputMode: "numeric" as const,
      autoComplete: "off",
      value: text,
      "aria-invalid": error ? true : undefined,
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        setText(e.target.value);
        onValueChange(parseWholeNumber(e.target.value));
      },
    },
  };
}

/** True when any value of a draft is a number the admin typed but that did not parse (NaN). */
export const hasInvalidNumber = (draft: object) => Object.values(draft).some((v) => typeof v === "number" && Number.isNaN(v));
