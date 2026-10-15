import { ago, timeWIB } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** "3 jam lalu" with the exact WIB time in a tooltip (and the native title for touch/long-press). */
export function RelativeTime({ value, now = Date.now(), className }: { value: number; now?: number; className?: string }) {
  const exact = `${timeWIB(value)} WIB`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={new Date(value).toISOString()} title={exact} className={className ?? "whitespace-nowrap"}>
          {ago(now - value)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{exact}</TooltipContent>
    </Tooltip>
  );
}
