import React from "react";
import { cn } from "cn";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useWholeNumber } from "@/hooks/use-whole-number";

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

/** Whole-number input bound to `number | null`; an empty box is null, text that is not a whole number is NaN. */
export function NumberField({
  value,
  onValueChange,
  label,
  hint,
  className,
  min,
  max,
  ...props
}: Omit<React.ComponentProps<typeof TextField>, "value" | "onChange" | "type" | "min" | "max"> & {
  value: number | null;
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
}) {
  const { error, inputProps } = useWholeNumber(value, onValueChange, { min, max });
  return (
    <Field label={label} hint={error ? undefined : hint} required={props.required} className={className}>
      {(id) => (
        <>
          <Input id={id} {...props} {...inputProps} aria-describedby={error ? `${id}-error` : undefined} />
          {error && (
            <p id={`${id}-error`} className="text-xs text-destructive">
              {error}
            </p>
          )}
        </>
      )}
    </Field>
  );
}

/** Label-less whole-number input for table cells; shows its own error under the box. */
export function WholeNumberInput({
  value,
  onValueChange,
  min,
  max,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "type" | "min" | "max"> & {
  value: number | null;
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
}) {
  const { error, inputProps } = useWholeNumber(value, onValueChange, { min, max });
  return (
    <div className="grid gap-1">
      <Input {...props} {...inputProps} />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
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
