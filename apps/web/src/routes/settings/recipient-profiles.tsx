import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";
import { CHANNEL_MESSAGES, TRIGGER_MESSAGES } from "../../lib/messages";

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
    <main>
      <h1>{t(locale, "web.settings.profiles.title")}</h1>
      <p>
        <Link to="/settings">{t(locale, "web.settings.title")}</Link>
      </p>
      {error !== null && <p role="alert">{error}</p>}
      {!isAdmin && <p>{t(locale, "web.common.adminOnly")}</p>}
      {profiles === null ? (
        <p>{t(locale, "web.common.loading")}</p>
      ) : (
        profiles.map((profile) => (
          <section key={profile.id}>
            <h2>
              {profile.recipient}{" "}
              {profile.paused ? `— ${t(locale, "web.settings.profiles.paused")}` : ""}
            </h2>
            <dl>
              <dt>{t(locale, "web.settings.profiles.version")}</dt>
              <dd>{profile.version}</dd>
              <dt>{t(locale, "web.settings.profiles.channel")}</dt>
              <dd>{t(locale, CHANNEL_MESSAGES[profile.channel])}</dd>
              <dt>{t(locale, "web.settings.profiles.account")}</dt>
              <dd>{profile.account}</dd>
              <dt>{t(locale, "web.settings.profiles.trigger")}</dt>
              <dd>
                {t(locale, TRIGGER_MESSAGES[profile.compositionTrigger])}
                {profile.windowTime !== undefined ? ` ${profile.windowTime}` : ""}
              </dd>
              <dt>{t(locale, "web.settings.profiles.territories")}</dt>
              <dd>{profile.eligibleTerritories.join(", ")}</dd>
            </dl>
            {isAdmin && (
              <>
                <form
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
                  <label>
                    {t(locale, "web.settings.profiles.account")}
                    <input
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
                  <label>
                    {t(locale, "web.settings.profiles.territories")}
                    <input
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
                  <button type="submit" disabled={busy}>
                    {t(locale, "web.settings.profiles.save")}
                  </button>
                </form>
                {profile.paused && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void clearPause(profile);
                    }}
                  >
                    <label>
                      {t(locale, "web.settings.profiles.clearanceReason")}
                      <input
                        value={clearanceReason}
                        onChange={(e) => setClearanceReason(e.target.value)}
                        required
                      />
                    </label>
                    <button type="submit" disabled={busy}>
                      {t(locale, "web.settings.profiles.clearPause")}
                    </button>
                  </form>
                )}
              </>
            )}
          </section>
        ))
      )}
    </main>
  );
}
