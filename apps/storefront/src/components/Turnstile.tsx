import { useEffect, useRef, useState } from "react";
declare global {
  interface Window {
    turnstile?: {
      render: (
        element: HTMLElement,
        options: Record<string, unknown>,
      ) => string;
      remove: (id: string) => void;
    };
  }
}
export default function Turnstile({
  siteKey,
  onToken,
  reset,
}: {
  siteKey: string;
  onToken: (token: string) => void;
  reset: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let widget: string | undefined;
    let disposed = false;
    setError("");
    callback.current("");
    const scriptError = () =>
      setError(
        "Verifikasi tidak dapat dimuat. Periksa koneksi lalu muat ulang halaman.",
      );
    const render = () => {
      if (disposed || !ref.current || !window.turnstile) return;
      widget = window.turnstile.render(ref.current, {
        sitekey: siteKey,
        action: "checkout",
        callback: (t: string) => callback.current(t),
        "expired-callback": () => callback.current(""),
        "error-callback": () => {
          callback.current("");
          setError(
            "Verifikasi gagal. Muat ulang verifikasi untuk mencoba lagi.",
          );
        },
      });
    };
    let script = document.querySelector<HTMLScriptElement>(
      "script[data-turnstile]",
    );
    if (window.turnstile) render();
    else {
      if (!script) {
        script = document.createElement("script");
        script.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.dataset.turnstile = "true";
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", render);
      script.addEventListener("error", scriptError);
    }
    return () => {
      disposed = true;
      script?.removeEventListener("load", render);
      script?.removeEventListener("error", scriptError);
      if (widget) window.turnstile?.remove(widget);
    };
  }, [siteKey, reset, retry]);
  return (
    <>
      <div ref={ref} />
      {error && <p role="alert">{error}</p>}
      {error && window.turnstile && (
        <button type="button" onClick={() => setRetry((r) => r + 1)}>
          Muat ulang verifikasi
        </button>
      )}
    </>
  );
}
