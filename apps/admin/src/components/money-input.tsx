import React from "react";
import { cn } from "cn";
import { money } from "@/lib/format";
import { Input } from "@/components/ui/input";

/** Integer IDR input bound to `number | null` with a live "Rp 150.000" preview under it. */
export function MoneyInput({
  value,
  onValueChange,
  className,
  wrapperClassName,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "type"> & {
  value: number | null;
  onValueChange: (value: number | null) => void;
  wrapperClassName?: string;
}) {
  return (
    <div className={cn("grid gap-1", wrapperClassName)}>
      <Input
        type="number"
        inputMode="numeric"
        step={1}
        min={0}
        className={className}
        value={value ?? ""}
        onChange={(e) => onValueChange(e.target.value === "" ? null : Number(e.target.value))}
        {...props}
      />
      <span className="min-h-4 text-xs text-muted-foreground tabular-nums" aria-hidden="true">
        {value != null && Number.isFinite(value) ? money(value) : ""}
      </span>
    </div>
  );
}
