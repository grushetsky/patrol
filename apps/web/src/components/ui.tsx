import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/**
 * The prototype's panel composition (glass.css): an uppercase labelled head
 * with an action slot, and a padded body. `tone` tints the card the way the
 * prototype tints its stat and notice cards.
 */
export function Panel(props: {
  title?: ReactNode;
  actions?: ReactNode;
  tone?: "red" | "blue" | "amber" | "green" | "violet";
  children: ReactNode;
  labelledBy?: string;
}) {
  const { title, actions, tone, children, labelledBy } = props;
  const headingId = labelledBy ?? (typeof title === "string" ? `panel-${title}` : undefined);
  return (
    <section
      className="panel"
      aria-labelledby={title !== undefined ? headingId : undefined}
      style={tone !== undefined ? ({ "--tint": `var(--tint-${tone})` } as React.CSSProperties) : undefined}
    >
      {title !== undefined && (
        <header className="panel-head">
          <h2 id={headingId}>{title}</h2>
          {actions}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** The prototype's uppercase pill chip (theme.css .chip). */
export function Chip(props: {
  tone?: "live" | "danger" | "blue" | "green" | "amber" | "locked" | "muted";
  dot?: boolean;
  children: ReactNode;
}) {
  const { tone, dot, children } = props;
  return (
    <span className={tone !== undefined ? `chip chip--${tone}` : "chip"}>
      {dot === true && <span className="dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** The engine glyph tile: G / B / Я with each engine's brand tint. */
export function EngineBadge(props: { engine: "google" | "bing" | "yandex" }) {
  const glyph = props.engine === "google" ? "G" : props.engine === "bing" ? "B" : "Я";
  return (
    <span className="engine-badge" data-engine={props.engine} aria-hidden="true">
      <span className="engine-glyph">{glyph}</span>
    </span>
  );
}

/** One dashboard counter tile (prototype .stat). */
export function Stat(props: {
  icon: IconName;
  tone?: "red" | "amber" | "blue" | "green";
  value: ReactNode;
  label: ReactNode;
  href?: string;
}) {
  const { icon, tone, value, label, href } = props;
  const body = (
    <>
      <span className="stat-icon">
        <Icon name={icon} />
      </span>
      <span className="stat-num">{value}</span>
      <span className="stat-label">{label}</span>
    </>
  );
  if (href !== undefined) {
    return (
      <a className="stat" data-tone={tone} href={href}>
        {body}
      </a>
    );
  }
  return (
    <div className="stat" data-tone={tone}>
      {body}
    </div>
  );
}

/** The shimmering placeholder bar (prototype .skeleton). */
export function Skeleton(props: { variant?: "score" | "wide" | "short" | "chart" | "stat" | "plain" }) {
  const { variant = "plain" } = props;
  return (
    <span
      className={variant === "plain" ? "skeleton" : `skeleton skeleton--${variant}`}
      aria-hidden="true"
    />
  );
}

/** The screen's degraded-data explanation with its primary action
 *  (dashboard-ui.md "States": each empty screen shows an explanation and an
 *  action). */
export function EmptyState(props: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const { title, children, action } = props;
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="check" size="lg" />
      </span>
      <h2>{title}</h2>
      {children !== undefined && <p>{children}</p>}
      {action}
    </div>
  );
}

/** The page header every screen opens with (prototype .page-head). */
export function PageHead(props: { eyebrow?: ReactNode; title: ReactNode; note?: ReactNode; actions?: ReactNode }) {
  const { eyebrow, title, note, actions } = props;
  return (
    <div className="page-head">
      <div>
        {eyebrow !== undefined && (
          <p className="eyebrow">
            <span className="dot" aria-hidden="true" />
            {eyebrow}
          </p>
        )}
        <h1 className="page-title">{title}</h1>
      </div>
      {note !== undefined && <p className="head-note">{note}</p>}
      {actions}
    </div>
  );
}
