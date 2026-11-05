import { useEffect, useState } from "react";
import { interpolate, t } from "@patrol/i18n";
import { api } from "./api/client";
import { useSession } from "./session";

/**
 * The pending-count badge the app shell's section tabs carry
 * (docs/design/dashboard-ui.md "Shell"): Review, Violations, and Notices
 * each show their pending count, where Notices' pending is the draft count
 * the dashboard summary's counters already answer from. The shared tab bar
 * itself arrives with the shell alignment (AICHAMP-20); this component is
 * the badge that bar — and, until then, the screens' headers — renders.
 */
export function NoticesBadge() {
  const { locale } = useSession();
  const [drafts, setDrafts] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void api.GET("/dashboard/summary").then(({ data, response }) => {
      if (live && response.ok && data) {
        setDrafts(data.counters.draftNotices);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  // Nothing pending, nothing to announce: the badge stays absent rather
  // than reading a bare zero beside the section's name.
  if (drafts === null || drafts === 0) {
    return null;
  }
  return (
    <span
      aria-label={interpolate(t(locale, "web.nav.badge.draftNotices"), {
        count: String(drafts),
      })}
    >
      {drafts}
    </span>
  );
}
