import { useEffect, useState } from "react";

/** Slightly shorter than the server's two minutes so the page never claims a
 *  window the server has already closed. */
const WINDOW_MS = 115_000;

let until = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Called by the API client after a gated request succeeded with codes. */
export function markConfirmed(now = Date.now()) {
  until = now + WINDOW_MS;
  notify();
}

/** Called when the server refused a gated request: the window is gone. */
export function clearConfirmed() {
  if (until === 0) return;
  until = 0;
  notify();
}

export function confirmWindowOpen(now = Date.now()): boolean {
  return until > now;
}

/** Seconds left in the no-codes window, or 0. Re-renders every second while open. */
export function useConfirmWindow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const listener = () => setNow(Date.now());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  useEffect(() => {
    if (left <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), 1000);
    return () => window.clearTimeout(timer);
  }, [left, now]);
  return left;
}
