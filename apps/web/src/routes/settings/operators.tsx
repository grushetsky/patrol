import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";
import { Chip, PageHead, Panel, Skeleton } from "../../components/ui";

/**
 * The operators and invitations screen (slice 9's remaining administrator
 * surface): the accounts with their roles and states, the credential
 * reset, any operator's active sessions with per-session revocation, and
 * the invitation lifecycle — every operation the slice-1 API routes
 * carry, wired to the buttons an administrator actually clicks. A role or
 * state change revokes the target's sessions server-side; this screen
 * shows that by re-reading the session list after the change.
 */
export const Route = createFileRoute("/settings/operators")({
  component: OperatorsScreen,
});

interface OperatorRow {
  id: string;
  email: string;
  role: "operator" | "administrator";
  state: "active" | "disabled";
  lastSignInAt?: string;
}

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
}

interface InvitationRow {
  invitation: {
    id: string;
    email: string;
    role: "operator" | "administrator";
    createdAt: string;
    expiresAt: string;
    acceptedAt?: string;
    revokedAt?: string;
  };
  state: "pending" | "accepted" | "revoked" | "expired";
}

function OperatorsScreen() {
  const { locale, role } = useSession();
  const isAdmin = role === "administrator";
  const [operators, setOperators] = useState<OperatorRow[] | null>(null);
  const [invitations, setInvitations] = useState<InvitationRow[] | null>(null);
  const [sessions, setSessions] = useState<Record<string, SessionRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"operator" | "administrator">("operator");

  const load = useCallback(async () => {
    const ops = await api.GET("/operators");
    if (ops.response.ok && ops.data) {
      setOperators(ops.data.items as OperatorRow[]);
    } else {
      setError(t(locale, "web.common.error"));
    }
    const invites = await api.GET("/invitations");
    if (invites.response.ok && invites.data) {
      setInvitations(invites.data.items as InvitationRow[]);
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  async function withCsrf<T>(run: (token: string) => Promise<T>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      await run(csrfToken);
    } finally {
      setBusy(false);
    }
  }

  const loadSessions = useCallback(async (operatorId: string) => {
    const result = await api.GET("/operators/{operatorId}/sessions", {
      params: { path: { operatorId } },
    });
    if (result.response.ok && result.data) {
      setSessions((current) => ({
        ...current,
        [operatorId]: (result.data as { items: SessionRow[] }).items,
      }));
    }
  }, []);

  function patchOperator(operator: OperatorRow, body: Record<string, unknown>) {
    return withCsrf(async (csrfToken) => {
      const { response } = await api.PATCH("/operators/{operatorId}", {
        params: {
          path: { operatorId: operator.id },
          header: { "X-Patrol-CSRF": csrfToken },
        },
        body,
      });
      if (response.ok) {
        await load();
        await loadSessions(operator.id);
        return;
      }
      setError(t(locale, "web.common.error"));
    });
  }

  function resetCredentials(operator: OperatorRow) {
    return withCsrf(async (csrfToken) => {
      const { response } = await api.POST(
        "/operators/{operatorId}/credential-reset",
        {
          params: {
            path: { operatorId: operator.id },
            header: { "X-Patrol-CSRF": csrfToken },
          },
          body: {},
        },
      );
      if (response.ok) {
        setNotice(t(locale, "web.settings.operators.reset.sent"));
        return;
      }
      setError(t(locale, "web.common.error"));
    });
  }

  function revokeSession(operatorId: string, sessionId: string) {
    return withCsrf(async (csrfToken) => {
      const { response } = await api.DELETE(
        "/operators/{operatorId}/sessions/{sessionId}",
        {
          params: {
            path: { operatorId, sessionId },
            header: { "X-Patrol-CSRF": csrfToken },
          },
        },
      );
      if (response.ok) {
        await loadSessions(operatorId);
        return;
      }
      setError(t(locale, "web.common.error"));
    });
  }

  function invite(event: React.FormEvent) {
    event.preventDefault();
    return withCsrf(async (csrfToken) => {
      const { response } = await api.POST("/invitations", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: { email: inviteEmail, role: inviteRole },
      });
      if (response.ok) {
        setInviteEmail("");
        await load();
        return;
      }
      setError(t(locale, "web.common.error"));
    });
  }

  function revokeInvitation(invitationId: string) {
    return withCsrf(async (csrfToken) => {
      const { response } = await api.DELETE("/invitations/{invitationId}", {
        params: {
          path: { invitationId },
          header: { "X-Patrol-CSRF": csrfToken },
        },
      });
      if (response.ok) {
        await load();
        return;
      }
      setError(t(locale, "web.common.error"));
    });
  }

  const roleKey = (value: "operator" | "administrator") =>
    value === "operator"
      ? "web.settings.operators.role.operator"
      : "web.settings.operators.role.administrator";

  return (
    <main className="page stack">
      <PageHead
        eyebrow={t(locale, "web.nav.settings")}
        title={t(locale, "web.settings.operators.title")}
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
      {notice !== null && (
        <p className="banner" role="status">
          {notice}
        </p>
      )}
      {!isAdmin && <p className="page-note">{t(locale, "web.common.adminOnly")}</p>}

      <Panel title={t(locale, "web.settings.operators.operators")}>
        {operators === null ? (
          <div aria-busy="true">
            {[0, 1].map((index) => (
              <div key={index} style={{ padding: "10px 0" }}>
                <Skeleton variant="wide" />
              </div>
            ))}
          </div>
        ) : (
          operators.map((operator) => (
            <div key={operator.id} className="operator-row" style={{ borderBottom: "1px solid var(--line)", padding: "12px 0" }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <span className="mono">{operator.email}</span>
                <Chip tone={operator.role === "administrator" ? "blue" : "muted"}>
                  {t(locale, roleKey(operator.role))}
                </Chip>
                <Chip tone={operator.state === "active" ? "green" : "amber"} dot>
                  {t(
                    locale,
                    operator.state === "active"
                      ? "web.settings.operators.state.active"
                      : "web.settings.operators.state.disabled",
                  )}
                </Chip>
                {isAdmin && (
                  <span style={{ display: "inline-flex", gap: 8, marginLeft: "auto" }}>
                    <select
                      className="select"
                      aria-label={t(locale, "web.settings.operators.role")}
                      value={operator.role}
                      onChange={(e) =>
                        void patchOperator(operator, { role: e.target.value })
                      }
                      disabled={busy}
                    >
                      <option value="operator">
                        {t(locale, "web.settings.operators.role.operator")}
                      </option>
                      <option value="administrator">
                        {t(locale, "web.settings.operators.role.administrator")}
                      </option>
                    </select>
                    <button
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() =>
                        void patchOperator(operator, {
                          state: operator.state === "active" ? "disabled" : "active",
                        })
                      }
                    >
                      {t(
                        locale,
                        operator.state === "active"
                          ? "web.settings.operators.state.disabled"
                          : "web.settings.operators.state.active",
                      )}
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resetCredentials(operator)}>
                      {t(locale, "web.settings.operators.reset")}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => {
                        if (sessions[operator.id] === undefined) {
                          void loadSessions(operator.id);
                        } else {
                          setSessions((current) => {
                            const next = { ...current };
                            delete next[operator.id];
                            return next;
                          });
                        }
                      }}
                    >
                      {t(locale, "web.settings.operators.sessions")}
                    </button>
                  </span>
                )}
              </div>
              {sessions[operator.id] !== undefined && (
                <div style={{ marginTop: 10 }}>
                  {sessions[operator.id]!.length === 0 ? (
                    <p className="page-note" style={{ margin: 0 }}>
                      {t(locale, "web.settings.operators.sessions.none")}
                    </p>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                      {sessions[operator.id]!.map((session) => (
                        <li
                          key={session.id}
                          style={{ display: "flex", gap: 12, alignItems: "center", padding: "4px 0" }}
                        >
                          <span className="mono" style={{ fontSize: 12 }}>
                            {session.id.slice(0, 8)}
                          </span>
                          <span style={{ fontSize: 12, opacity: 0.75 }}>
                            {session.lastSeenAt}
                          </span>
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void revokeSession(operator.id, session.id)}
                          >
                            {t(locale, "web.settings.operators.sessions.revoke")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </Panel>

      <Panel title={t(locale, "web.settings.operators.invitations")}>
        {isAdmin && (
          <form className="form-row" onSubmit={invite}>
            <label className="field">
              <span>{t(locale, "web.settings.operators.invite.email")}</span>
              <input
                className="input"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>{t(locale, "web.settings.operators.invite.role")}</span>
              <select
                className="select"
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(e.target.value as "operator" | "administrator")
                }
              >
                <option value="operator">
                  {t(locale, "web.settings.operators.role.operator")}
                </option>
                <option value="administrator">
                  {t(locale, "web.settings.operators.role.administrator")}
                </option>
              </select>
            </label>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {t(locale, "web.settings.operators.invite.submit")}
            </button>
          </form>
        )}
        {invitations === null ? (
          <div aria-busy="true" style={{ marginTop: 12 }}>
            <Skeleton variant="wide" />
          </div>
        ) : invitations.length === 0 ? (
          <p className="page-note" style={{ marginTop: 12 }}>
            {t(locale, "web.settings.operators.invitations.empty")}
          </p>
        ) : (
          <ul style={{ margin: "12px 0 0", paddingLeft: 0, listStyle: "none" }}>
            {invitations.map(({ invitation, state }) => (
              <li
                key={invitation.id}
                style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 0" }}
              >
                <span className="mono">{invitation.email}</span>
                <Chip tone={state === "pending" ? "amber" : "muted"} dot={state === "pending"}>
                  {t(locale, `web.settings.operators.invite.state.${state}` as never)}
                </Chip>
                <span style={{ fontSize: 12, opacity: 0.75 }}>
                  {t(locale, roleKey(invitation.role))}
                </span>
                {isAdmin && state === "pending" && (
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void revokeInvitation(invitation.id)}
                  >
                    {t(locale, "web.settings.operators.invite.revoke")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </main>
  );
}
