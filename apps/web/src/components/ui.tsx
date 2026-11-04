import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const variants: Record<ButtonVariant, string> = {
    primary:
      "bg-[var(--accent)] text-[#08111c] hover:brightness-110 disabled:opacity-50",
    secondary:
      "border border-[var(--border)] bg-[var(--surface-raised)] text-[var(--fg)] hover:border-[var(--accent)]",
    ghost: "text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--fg)]",
    danger:
      "border border-[color-mix(in_srgb,var(--error)_55%,var(--border))] text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)]",
  };
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed",
        variants[variant],
        className,
      )}
    />
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-[var(--border)] bg-[var(--surface)]/90 shadow-[0_18px_50px_-30px_rgba(0,0,0,0.7)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  action,
  subtitle,
}: {
  title: ReactNode;
  action?: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-[var(--fg)]">{title}</h2>
        {subtitle ? (
          <p className="mt-1 text-xs text-[var(--muted)]">{subtitle}</p>
        ) : null}
      </div>
      {action}
    </header>
  );
}

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "error";

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: "border-[var(--border)] text-[var(--muted)]",
    accent: "border-[var(--accent)]/40 text-[var(--accent)] bg-[var(--accent)]/10",
    success: "border-[var(--success)]/40 text-[var(--success)] bg-[var(--success)]/10",
    warning: "border-[var(--warning)]/40 text-[var(--warning)] bg-[var(--warning)]/10",
    error: "border-[var(--error)]/40 text-[var(--error)] bg-[var(--error)]/10",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)] outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)]",
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium text-[var(--fg)]">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-[var(--muted)]">{hint}</span> : null}
    </label>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-[var(--muted)]">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
      {label}
    </span>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <h3 className="text-base font-semibold">{title}</h3>
      {children ? <p className="max-w-md text-sm text-[var(--muted)]">{children}</p> : null}
      {action}
    </div>
  );
}
