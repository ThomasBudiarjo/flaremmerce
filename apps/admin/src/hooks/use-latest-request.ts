import { useCallback, useEffect, useRef } from "react";

/**
 * Hands out an AbortController per call, aborting the previous one and any in-flight
 * request on unmount. Callers treat an aborted signal as "result no longer wanted".
 */
export function useLatestRequest() {
  const current = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      current.current?.abort();
    },
    [],
  );
  return useCallback(() => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    return controller;
  }, []);
}
