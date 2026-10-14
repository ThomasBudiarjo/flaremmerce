import { useCallback, useEffect, useState } from "react";
import { get } from "@/lib/api";
import { useLatestRequest } from "./use-latest-request";

/**
 * Single GET resource. A path change or plain reload clears the previous data first, so
 * protected details are never shown for the wrong entity; `reload({ keep: true })` refreshes in place.
 */
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!!path);
  const begin = useLatestRequest();

  const reload = useCallback(
    async (options: { keep?: boolean } = {}) => {
      if (!path) return;
      const controller = begin();
      if (!options.keep) setData(null);
      setLoading(true);
      setError("");
      try {
        const result = await get<T>(path, controller.signal);
        if (!controller.signal.aborted) setData(result);
      } catch (e) {
        if (!controller.signal.aborted) {
          if (!options.keep) setData(null);
          setError((e as Error).message);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [path, begin],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, setData, error, loading, reload };
}
