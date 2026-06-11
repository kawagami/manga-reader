import { useEffect, useRef } from "react";

export interface KeyBinding {
  code?: string;  // e.code (physical key, e.g. "Numpad0", "PageUp")
  key?: string;   // e.key  (logical key, e.g. "ArrowUp", " ")
  alt?: boolean;  // require altKey pressed (default: false)
  // Return false to decline the event: no preventDefault, so the browser
  // default (e.g. native scrolling) still runs.
  handler: () => void | boolean;
}

export function useKeyboardShortcuts(bindings: KeyBinding[]) {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const b of ref.current) {
        const altMatch = (b.alt ?? false) === e.altKey;
        const codeMatch = b.code === undefined || e.code === b.code;
        const keyMatch = b.key === undefined || e.key === b.key;
        const hasTarget = b.code !== undefined || b.key !== undefined;
        if (hasTarget && codeMatch && keyMatch && altMatch) {
          if (b.handler() === false) continue;
          e.preventDefault();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
