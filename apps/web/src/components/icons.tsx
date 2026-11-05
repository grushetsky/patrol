import type { ReactNode } from "react";

/**
 * The prototype's icon set, carried over verbatim from its inline SVG symbol
 * table (prototype/index.html): 24×24 viewBox, 1.7 stroke, round caps — one
 * geometric language for every glyph in the interface.
 */

const PATHS: Record<string, ReactNode> = {
  shield: (
    <>
      <path d="M12 2.8 19 5.8v5.4c0 4.4-2.9 7.7-7 9.4-4.1-1.7-7-5-7-9.4V5.8l7-3Z" />
      <path d="m8.8 12.1 2.2 2.2 4.2-4.4" />
    </>
  ),
  radar: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="4.6" />
      <path d="M12 12 17.6 6.4" />
      <circle cx="15.4" cy="14.8" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M8 5v14M16 5v14" />
      <path d="M3 10h5M3 14h5M16 10h5M16 14h5" />
    </>
  ),
  check: <path d="m5 12.6 4.4 4.4L19 7" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8.5 10V7.6a3.5 3.5 0 0 1 7 0V10" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 17h6M9 9h2" />
    </>
  ),
  send: (
    <>
      <path d="M21 4 3 11l7 2 2 7 9-16Z" />
      <path d="m10 13 5-5" />
    </>
  ),
  play: <path d="M8 5.5v13l11-6.5-11-6.5Z" />,
  pause: <path d="M9 5v14M15 5v14" />,
  arrow: <path d="M4 12h15M13 6l6 6-6 6" />,
  eye: (
    <>
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </>
  ),
  bolt: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z" />
    </>
  ),
  link: (
    <>
      <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.3 1.3" />
      <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.3-1.3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: (
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="m12 14 4-4" />
      <circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  spark: (
    <>
      <path d="M12 2.8l1.8 6.4L20.2 11l-6.4 1.8L12 19.2l-1.8-6.4L3.8 11l6.4-1.8L12 2.8Z" />
      <path d="M19 3v3M17.5 4.5h3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
};

export type IconName = keyof typeof PATHS;

/** One glyph of the prototype set; decorative by default — name it when it
 *  carries meaning (`title`) so it stays announced. */
export function Icon(props: {
  name: IconName;
  size?: "sm" | "md" | "lg";
  title?: string;
  className?: string;
}) {
  const { name, size = "md", title, className } = props;
  const sizeClass = size === "sm" ? "icon icon--sm" : size === "lg" ? "icon icon--lg" : "icon";
  return (
    <svg viewBox="0 0 24 24" aria-hidden={title === undefined || undefined} className={className ? `${sizeClass} ${className}` : sizeClass} role={title !== undefined ? "img" : undefined}>
      {title !== undefined ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
