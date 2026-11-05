import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";
import { CHANNEL_MESSAGES, TRIGGER_MESSAGES } from "../../lib/messages";
import { Chip, EngineBadge, PageHead, Panel, Skeleton } from "../../components/ui";

/**
 * The recipient profiles: one row per recipient with its version, pause
 * state, eligibility, and the administrator-only edit and clearance forms.
 */
export const Route = createFileRoute("/settings/recipient-profiles")({
  component: RecipientProfiles,
});

interface Profile {
  id: string;
  recipient: "google" | "bing" | "yandex";
  channel: "web_form" | "trusted_program";
  account: string;
  contactEmail?: string;
  compositionTrigger: "scheduled" | "on_demand";
  windowTime?: string;
  eligibleTerritories: string[];
  paused: boolean;
  version: number;
}

function RecipientProfiles() {
  const { locale, role } = useSession();
  const isAdmin = role === "administrator";
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearanceReason, setClearanceReason] = useState("");

  const load = useCallback(async () => {
    const { data, response } = await api.GET("/settings/recipient-profiles");
    if (response.ok && data) {
      setProfiles(data.items as Profile[]);
    } else {
      setError(t(locale, "web.common.error"));
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(profile: Profile, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      const { response } = await api.PATCH(
        "/settings/recipient-profiles/{recipientProfileId}",
        {
          params: {
            path: { recipientProfileId: profile.id },
            header: { "X-Patrol-CSRF": csrfToken },
          },
          body,
        },
      );
      if (response.ok) {
        await load();
        return;
      }
      setError(t(locale, "web.common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function clearPause(profile: Profile) {
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      const { response } = await api.POST(
        "/settings/recipient-profiles/{recipientProfileId}/clearance",
        {
          params: {
            path: { recipientProfileId: profile.id },
            header: { "X-Patrol-CSRF": csrfToken },
          },
          body: { reason: clearanceReason },
        },
      );
      if (response.ok) {
        await load();
        return;
      }
      setError(t(locale, "web.common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page stack">
      <PageHead
        eyebrow={t(locale, "web.nav.settings")}
        title={t(locale, "web.settings.profiles.title")}
        actions={
          <Link className="btn btn-ghost btn-sm" to="/settings">
            {t(locale, "web.settings.title")}
          </Link>
        }
      />
      {error !== null && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      {!isAdmin && <p className="page-note">{t(locale, "web.common.adminOnly")}</p>}
      {profiles === null ? (
        <div aria-busy="true">
          {[0, 1, 2].map((index) => (
            <div key={index} style={{ padding: "10px 0" }}>
              <Skeleton variant="wide" />
            </div>
          ))}
        </div>
      ) : (
        profiles.map((profile) => (
          <Panel
            key={profile.id}
            title={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <EngineBadge engine={profile.recipient} />
                {profile.recipient}
                {profile.paused && (
                  <Chip tone="amber" dot>
                    {t(locale, "web.settings.profiles.paused")}
                  </Chip>
                )}
              </span>
            }
          >
            <dl className="kv" style={{ marginBottom: isAdmin ? 16 : 0 }}>
              <dt>{t(locale, "web.settings.profiles.version")}</dt>
              <dd>{profile.version}</dd>
              <dt>{t(locale, "web.settings.profiles.channel")}</dt>
              <dd>{t(locale, CHANNEL_MESSAGES[profile.channel])}</dd>
              <dt>{t(locale, "web.settings.profiles.account")}</dt>
              <dd className="mono">{profile.account}</dd>
              <dt>{t(locale, "web.settings.profiles.trigger")}</dt>
              <dd>
                {t(locale, TRIGGER_MESSAGES[profile.compositionTrigger])}
                {profile.windowTime !== undefined ? ` ${profile.windowTime}` : ""}
              </dd>
              <dt>{t(locale, "web.settings.profiles.territories")}</dt>
              <dd className="mono">{profile.eligibleTerritories.join(", ")}</dd>
            </dl>
            {isAdmin && (
              <>
                <form
                  className="form-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void patch(profile, {
                      account: profile.account,
                      eligibleTerritories: profile.eligibleTerritories,
                      channel: profile.channel,
                      compositionTrigger: profile.compositionTrigger,
                    });
                  }}
                >
                  <label className="field">
                    <span>{t(locale, "web.settings.profiles.account")}</span>
                    <input
                      className="input mono"
                      value={profile.account}
                      onChange={(e) =>
                        setProfiles(
                          (profiles ?? []).map((row) =>
                            row.id === profile.id
                              ? { ...row, account: e.target.value }
                              : row,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="field" style={{ flex: "1 1 240px" }}>
                    <span>{t(locale, "web.settings.profiles.territories")}</span>
                    <input
                      className="input mono"
                      value={profile.eligibleTerritories.join(", ")}
                      onChange={(e) =>
                        setProfiles(
                          (profiles ?? []).map((row) =>
                            row.id === profile.id
                              ? {
                                  ...row,
                                  eligibleTerritories: e.target.value
                                    .split(",")
                                    .map((part) => part.trim())
                                    .filter((part) => part.length > 0),
                                }
                              : row,
                          ),
                        )
                      }
                    />
                  </label>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                    {t(locale, "web.settings.profiles.save")}
                  </button>
                </form>
                {profile.paused && (
                  <form
                    className="form-row"
                    style={{ marginTop: 12 }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void clearPause(profile);
                    }}
                  >
                    <label className="field" style={{ flex: "1 1 260px" }}>
                      <span>{t(locale, "web.settings.profiles.clearanceReason")}</span>
                      <input
                        className="input"
                        value={clearanceReason}
                        onChange={(e) => setClearanceReason(e.target.value)}
                        required
                      />
                    </label>
                    <button type="submit" className="btn btn-sm" disabled={busy}>
                      {t(locale, "web.settings.profiles.clearPause")}
                    </button>
                  </form>
                )}
              </>
            )}
          </Panel>
        ))
      )}
    </main>
  );
}
