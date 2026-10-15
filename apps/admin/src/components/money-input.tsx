import React from "react";
import { cn } from "cn";
import { money } from "@/lib/format";
import { useWholeNumber } from "@/hooks/use-whole-number";
import { Input } from "@/components/ui/input";

/** Integer IDR input bound to `number | null` with a live "Rp 150.000" preview under it; "150.000" is typed as is. */
export function MoneyInput({
  value,
  onValueChange,
  className,
  wrapperClassName,
  min = 0,
  max,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "type" | "min" | "max"> & {
  value: number | null;
  onValueChange: (value: number | null) => void;
  wrapperClassName?: string;
  min?: number;
  max?: number;
}) {
  const { error, inputProps } = useWholeNumber(value, onValueChange, { min, max });
  return (
    <div className={cn("grid gap-1", wrapperClassName)}>
      <Input className={className} {...props} {...inputProps} />
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : (
        <span className="min-h-4 text-xs text-muted-foreground tabular-nums" aria-hidden="true">
          {value != null && Number.isFinite(value) ? money(value) : ""}
        </span>
      )}
    </div>
  );
}
