import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

/** Icon button that copies `value` and confirms with a toast. `label` names what is copied, e.g. "email". */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn("text-muted-foreground print:hidden", className)}
      aria-label={`Salin ${label}`}
      title={`Salin ${label}`}
      onClick={async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success("Disalin");
        } catch {
          toast.error("Tidak dapat menyalin. Salin manual.");
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
