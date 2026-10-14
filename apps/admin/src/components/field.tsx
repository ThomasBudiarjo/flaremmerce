import React from "react";
import { cn } from "cn";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

/** Visual required marker; hidden from assistive tech because the control's `required` already announces it. */
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-0.5 text-destructive">
      *
    </span>
  );
}

/** Label + control + hint, wired by a generated id. `required` only marks the label; set it on the control too. */
export function Field({
  label,
  hint,
  required,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  required?: boolean;
  className?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className={cn("grid content-start gap-2", className)}>
      <Label htmlFor={id} className={required ? "gap-0" : undefined}>
        {label}
        {required && <RequiredMark />}
      </Label>
      {children(id)}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function TextField({
  label,
  hint,
  className,
  ...props
}: React.ComponentProps<typeof Input> & { label: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Field label={label} hint={hint} required={props.required} className={className}>
      {(id) => <Input id={id} {...props} />}
    </Field>
  );
}

/** Integer input bound to `number | null`; an empty box is null. */
export function NumberField({
  value,
  onValueChange,
  ...props
}: Omit<React.ComponentProps<typeof TextField>, "value" | "onChange"> & {
  value: number | null;
  onValueChange: (value: number | null) => void;
}) {
  return (
    <TextField
      type="number"
      inputMode="numeric"
      step={1}
      value={value ?? ""}
      onChange={(e) => onValueChange(e.target.value === "" ? null : Number(e.target.value))}
      {...props}
    />
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription className="flex flex-wrap items-center gap-2">
        {message}
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Coba lagi
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
