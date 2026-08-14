import { useEffect, useRef } from "react";

// Modifiers are matched exactly, and every unlisted one must be *up*: a binding
// for ArrowRight is a binding for ArrowRight, not for Ctrl+ArrowRight. Matching
// only the modifiers a binding names meant Ctrl/Shift/Meta combos turned pages
// and swallowed their own default (Shift+Space scroll-up, browser/OS shortcuts).
export interface KeyBinding {
  code?: string;   // e.code (physical key, e.g. "Numpad0", "PageUp")
  key?: string;    // e.key  (logical key, e.g. "ArrowUp", " ")
  alt?: boolean;   // require altKey pressed (default: false)
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
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
        const modMatch =
          (b.alt ?? false) === e.altKey &&
          (b.ctrl ?? false) === e.ctrlKey &&
          (b.shift ?? false) === e.shiftKey &&
          (b.meta ?? false) === e.metaKey;
        const codeMatch = b.code === undefined || e.code === b.code;
        const keyMatch = b.key === undefined || e.key === b.key;
        const hasTarget = b.code !== undefined || b.key !== undefined;
        if (hasTarget && codeMatch && keyMatch && modMatch) {
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
