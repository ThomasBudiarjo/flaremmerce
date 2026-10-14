import { useCallback, useId, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { HttpError } from "@/lib/api";

// Locks live outside React so that unmounting a dialog (or leaving a page) and mounting it
// again cannot hand out a second lock while the first request is still in flight.
const inflight = new Set<string>();
const listeners = new Set<() => void>();
function setLocked(key: string, locked: boolean) {
  if (locked) inflight.add(key);
  else inflight.delete(key);
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a mutation with this key is still waiting for the server. */
export const isLocked = (key: string) => inflight.has(key);

type Options<TResult> = {
  /**
   * Stable lock name. Give mutations that live inside dialogs or per-row components an explicit
   * key (e.g. `inventory-adjust:<variantId>`) so a remounted instance shares the same lock.
   */
  key?: string;
  /** Toast text on success; false stays silent. */
  success?: string | false | ((result: TResult) => string);
  onSuccess?: (result: TResult) => void;
  /** 409 compare-and-swap conflict: the server includes the current entity in details.current. */
  onConflict?: (current: unknown, error: HttpError) => void;
  onError?: (error: HttpError) => void;
};

export function useMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>, options: Options<TResult> = {}) {
  const fallback = useId();
  const key = options.key ?? `mutation${fallback}`;
  const latest = useRef({ fn, options });
  latest.current = { fn, options };
  const pending = useSyncExternalStore(subscribe, () => inflight.has(key));

  const mutate = useCallback(
    async (input: TInput): Promise<TResult | undefined> => {
      if (inflight.has(key)) return undefined;
      setLocked(key, true);
      try {
        const result = await latest.current.fn(input);
        const message = latest.current.options.success;
        if (message !== false) toast.success(typeof message === "function" ? message(result) : (message ?? "Perubahan tersimpan."));
        latest.current.options.onSuccess?.(result);
        return result;
      } catch (e) {
        const error = e instanceof HttpError ? e : new HttpError(0, (e as Error).message || "Koneksi terputus. Coba lagi.");
        const current = (error.details as { current?: unknown } | undefined)?.current;
        if (error.status === 409 && current !== undefined && latest.current.options.onConflict) {
          toast.error("Data sudah diubah orang lain.");
          latest.current.options.onConflict(current, error);
        } else {
          toast.error(error.message);
          latest.current.options.onError?.(error);
        }
        return undefined;
      } finally {
        setLocked(key, false);
      }
    },
    [key],
  );
  return { mutate, pending };
}
