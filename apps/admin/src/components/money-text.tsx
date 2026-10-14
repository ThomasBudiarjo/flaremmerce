import { cn } from "cn";
import { money } from "@/lib/format";

export function MoneyText({
  value,
  currency = "IDR",
  className,
}: {
  value: number;
  currency?: string;
  className?: string;
}) {
  return <span className={cn("tabular-nums", className)}>{money(value, currency)}</span>;
}
