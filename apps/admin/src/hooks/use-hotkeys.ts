import { useEffect, useRef } from "react";

/** True when the key event comes from a text field, select or editable region. */
export function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * Global keyboard shortcut. `combo` is a key such as "/" or "mod+k" (mod = Ctrl or Cmd).
 * Shortcuts are ignored while typing unless `whileTyping` is set (used for Ctrl/Cmd+S).
 */
export function useHotkey(combo: string, handler: (event: KeyboardEvent) => void, { enabled = true, whileTyping = false } = {}) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const mod = combo.startsWith("mod+");
    const key = (mod ? combo.slice(4) : combo).toLowerCase();
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.isComposing) return;
      if (event.key.toLowerCase() !== key || mod !== (event.ctrlKey || event.metaKey)) return;
      if (!whileTyping && isTyping(event.target)) return;
      event.preventDefault();
      latest.current(event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [combo, enabled, whileTyping]);
}

/**
 * While mounted, Ctrl/Cmd+S never opens the browser's "save page"; it submits the form with this id
 * (through requestSubmit, so native validation still runs) only when `canSubmit` is true.
 */
export function useSaveHotkey(formId: string, canSubmit: boolean) {
  useHotkey(
    "mod+s",
    () => {
      if (canSubmit) (document.getElementById(formId) as HTMLFormElement | null)?.requestSubmit();
    },
    { whileTyping: true },
  );
}
