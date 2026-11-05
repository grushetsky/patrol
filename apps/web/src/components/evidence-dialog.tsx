import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { evidenceQuery } from "../api/screens";
import { api, ApiError, errorMessage } from "../api/client";
import { translate, useLanguage, type MessageKey } from "../i18n";
import { Button, Card, Spinner } from "./ui";

export function EvidenceDialog({
  evidenceId,
  onClose,
}: {
  evidenceId: string;
  onClose: () => void;
}) {
  const language = useLanguage();
  const t = (key: MessageKey) => translate(language, key);
  const query = useQuery(evidenceQuery(evidenceId));
  const [error, setError] = useState<string | null>(null);

  async function download(sha256: string) {
    setError(null);
    try {
      const result = await api.GET(
        "/evidence/{evidenceId}/artifacts/{sha256}/download",
        { params: { path: { evidenceId, sha256 } } },
      );
      if (result.error || !result.data) {
        throw new ApiError(result.response.status, result.error);
      }
      window.location.assign(result.data.url);
    } catch (cause) {
      setError(errorMessage(cause, t("authErrorGeneric")));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("evidenceTitle")}
    >
      <Card className="max-h-[85vh] w-full max-w-3xl overflow-auto p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="auth-title text-2xl">{t("reviewEvidenceTitle")}</h2>
            <p className="mt-1 font-mono text-xs text-[var(--muted)]">{evidenceId}</p>
          </div>
          <Button variant="ghost" onClick={onClose}>
            {t("reviewClose")}
          </Button>
        </div>

        {query.isLoading ? <Spinner label={t("loading")} /> : null}
        {query.error ? (
          <p className="mt-4 text-sm text-[var(--error)]">
            {errorMessage(query.error, t("authErrorGeneric"))}
          </p>
        ) : null}
        {query.data ? (
          <div className="mt-5 space-y-4">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">{t("reviewUrl")}</dt>
                <dd className="break-all">{query.data.evidence.requestedUrl}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">{t("evidenceObserved")}</dt>
                <dd>
                  {new Date(query.data.evidence.observedAt).toLocaleString(
                    language === "ru" ? "ru-RU" : "en-US",
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">{t("evidenceOutcome")}</dt>
                <dd>{query.data.evidence.outcome}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">{t("reviewEvidence")}</dt>
                <dd>
                  {query.data.downloadAvailable
                    ? t("evidenceAvailable")
                    : t("evidencePurged")}
                </dd>
              </div>
            </dl>
            {error ? <p className="text-sm text-[var(--error)]">{error}</p> : null}
            <div>
              <h3 className="text-sm font-semibold">{t("reviewArtifacts")}</h3>
              {query.data.artifacts.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--muted)]">{t("reviewNoArtifacts")}</p>
              ) : (
                <div className="mt-2 divide-y divide-[var(--border)]">
                  {query.data.artifacts.map((artifact) => (
                    <div key={`${artifact.kind}-${artifact.sha256}`} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm">{artifact.kind}</p>
                        <p className="truncate font-mono text-[11px] text-[var(--muted)]">
                          {artifact.sha256}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        disabled={!query.data.downloadAvailable}
                        onClick={() => void download(artifact.sha256)}
                      >
                        {t("evidenceDownload")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
