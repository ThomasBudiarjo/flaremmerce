import type React from "react";
import { cn } from "cn";
import { LoaderCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** Inline spinner for actions and searches; the layout of the result is not known yet. */
export function Spinner({ className, delayed }: { className?: string; /** Fade in only if the wait lasts. */ delayed?: boolean }) {
  return <LoaderCircle aria-hidden className={cn("size-4 animate-spin motion-reduce:animate-none", delayed && "loading-reveal", className)} />;
}

/**
 * Leading icon of a search input. While a lookup is running the magnifier hands over to a spinner,
 * but only once the lookup outlasts the reveal delay, so fast results do not flicker the icon.
 */
export function SearchStatusIcon({ busy }: { busy: boolean }) {
  const place = "pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground";
  return (
    <>
      <Search aria-hidden className={cn(place, busy && "loading-conceal")} />
      {busy && <Spinner delayed className={place} />}
    </>
  );
}

/** "Load more" for keyset lists; rows already shown stay put while the next page loads. */
export function LoadMoreButton({ loading, onClick, className = "self-center" }: { loading: boolean; onClick: () => void; className?: string }) {
  return (
    <Button variant="outline" className={className} disabled={loading} onClick={onClick}>
      {loading ? (
        <>
          <Spinner />
          Memuat…
        </>
      ) : (
        "Muat lebih banyak"
      )}
    </Button>
  );
}

/** Fades freshly loaded content in; wraps the part of a page that replaces a skeleton. */
export function Reveal({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("content-reveal", className)} {...props} />;
}

function CardSkeleton({ lines }: { lines: number }) {
  return (
    <div className="grid gap-3 rounded-xl border p-6">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-64 max-w-full" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", ["w-full", "w-5/6", "w-2/3", "w-3/4"][i % 4])} />
      ))}
    </div>
  );
}

/** Placeholder shaped like the two-thirds/one-third card layout of the detail pages. */
export function DetailSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="loading-reveal grid items-start gap-6 lg:grid-cols-3">
      <div className="grid gap-6 lg:col-span-2">
        <CardSkeleton lines={4} />
        <CardSkeleton lines={2} />
      </div>
      <CardSkeleton lines={3} />
    </div>
  );
}

/** Placeholder for a grid of cards (operations sections). */
export function CardGridSkeleton({ label, count, className }: { label: string; count: number; className?: string }) {
  return (
    <div role="status" aria-label={label} className={cn("loading-reveal grid gap-6", className)}>
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} lines={2} />
      ))}
    </div>
  );
}
