import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/**
 * The prototype's toast rail (dashboard-ui.md "States": destructive or
 * state-changing actions raise a toast confirming the new state). Toasts are
 * polite announcements — they land in an aria-live region, carry a tone, and
 * clear themselves.
 */

interface Toast {
  id: number;
  text: string;
  tone: "blue" | "green" | "red";
}

type PushToast = (text: string, tone?: Toast["tone"]) => void;

const ToastContext = createContext<PushToast | null>(null);

export function ToastProvider(props: { children: ReactNode }) {
  const { children } = props;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback<PushToast>(
    (text, tone = "blue") => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => [...current.slice(-3), { id, text, tone }]);
      timers.current.set(id, setTimeout(() => dismiss(id), 5000));
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast" data-tone={toast.tone}>
            <Icon name={TOAST_ICONS[toast.tone]} />
            <span>{toast.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TOAST_ICONS: Record<Toast["tone"], IconName> = {
  blue: "bolt",
  green: "check",
  red: "x",
};

export function useToast(): PushToast {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error("useToast needs the app shell's ToastProvider");
  }
  return context;
}
