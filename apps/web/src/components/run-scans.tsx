import { useState } from "react";
import { api, ApiError, errorMessage } from "../api/client";
import { translate, type Language, type MessageKey } from "../i18n";
import { Button, Spinner } from "./ui";

interface TitleGroupOption {
  id: string;
  name: string;
}

export function RunScansButton({
  csrfToken,
  language,
}: {
  csrfToken: string;
  language: Language;
}) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<TitleGroupOption[] | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const t = (key: MessageKey) => translate(language, key);

  async function openDialog() {
    setOpen(true);
    setError(null);
    setNotice(null);
    if (groups) return;
    setBusy(true);
    try {
      const result = await api.GET("/title-groups", {
        params: { query: { pageSize: 200 } },
      });
      if (result.error || !result.data) {
        throw new ApiError(result.response.status, result.error);
      }
      setGroups(result.data.items.map((group) => ({ id: group.id, name: group.name })));
      setSelected(result.data.items[0]?.id ?? "");
    } catch (cause) {
      setError(errorMessage(cause, t("runScansFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function queueScan() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.POST("/scans", {
        body: { titleGroupId: selected, trigger: "manual" },
        params: { header: { "X-Patrol-CSRF": csrfToken } },
      });
      if (result.error) {
        throw new ApiError(result.response.status, result.error);
      }
      setOpen(false);
      setNotice(t("runScansQueued"));
    } catch (cause) {
      setError(errorMessage(cause, t("runScansFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => void openDialog()}>
        {t("runScans")}
      </Button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t("runScans")}
        >
          <div className="glass w-full max-w-md p-6">
            <h2 className="auth-title text-2xl">{t("runScans")}</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">{t("runScansChoose")}</p>
            {busy && !groups ? <Spinner label={t("loading")} /> : null}
            {groups && groups.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--muted)]">{t("runScansNone")}</p>
            ) : null}
            {groups && groups.length > 0 ? (
              <select
                className="glass-select mt-4 w-full px-3 py-2 text-sm"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            ) : null}
            {error ? <p className="mt-3 text-sm text-[var(--error)]">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("runScansCancel")}
              </Button>
              <Button
                onClick={() => void queueScan()}
                disabled={busy || !selected}
              >
                {t("runScans")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-4 py-2 text-sm shadow-[var(--glass-shadow)] backdrop-blur-xl">
          {notice}
        </div>
      ) : null}
    </>
  );
}
