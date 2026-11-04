import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { t } from "@patrol/i18n";
import { api } from "../../lib/api/client";
import { fetchSessionCsrfToken } from "../../lib/api/auth";
import { useSession } from "../../lib/session";
import { CADENCE_MESSAGES } from "../../lib/messages";

/**
 * The settings landing screen: the rights holder and signatory form, the
 * budget form, and the derived capacity projection. Both forms are
 * administrator-only writes; an operator sees the values but no forms.
 */
export const Route = createFileRoute("/settings/")({
  component: SettingsIndex,
});

interface RightsHolder {
  legalName: string;
  country: string;
  address?: { line1: string; line2?: string; city: string; region?: string; postalCode: string; country: string };
  roleMailbox?: string;
  phone?: string;
  signatory?: { fullLegalName: string; authorityBasis: string; contactEmail: string; contactPhone?: string };
  acquisitionBudget: {
    engineCaps: Array<{ engine: "google" | "bing" | "yandex"; monthlyCapMinor: number }>;
    recheckSharePercent: number;
  };
}

interface Capacity {
  localesPerTitle: number;
  cadence: "daily" | "every_other_day" | "weekly";
  queriesPerTitlePerScan: number;
  supportedTitles: number;
  trackedTitles: number;
  shortfallTitles: number;
}

const EMPTY_HOLDER: RightsHolder = {
  legalName: "",
  country: "",
  roleMailbox: "",
  acquisitionBudget: {
    engineCaps: [
      { engine: "google", monthlyCapMinor: 4800 },
      { engine: "bing", monthlyCapMinor: 0 },
      { engine: "yandex", monthlyCapMinor: 1200 },
    ],
    recheckSharePercent: 30,
  },
};

function SettingsIndex() {
  const { locale, role } = useSession();
  const isAdmin = role === "administrator";
  const [holder, setHolder] = useState<RightsHolder>(EMPTY_HOLDER);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [capacityLocales, setCapacityLocales] = useState("2");
  const [capacityCadence, setCapacityCadence] = useState<"daily" | "every_other_day" | "weekly">("daily");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, response } = await api.GET("/settings/rights-holder");
    if (response.ok && data) {
      setHolder(data as RightsHolder);
    }
    const projection = await api.GET("/settings/budget/capacity", {
      params: { query: { locales: Number.parseInt(capacityLocales, 10), cadence: capacityCadence } },
    });
    if (projection.response.ok && projection.data) {
      setCapacity(projection.data as Capacity);
    }
  }, [capacityCadence, capacityLocales]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveHolder(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      const { response } = await api.PATCH("/settings/rights-holder", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: {
          legalName: holder.legalName,
          country: holder.country,
          ...(holder.address !== undefined ? { address: holder.address } : {}),
          ...(holder.roleMailbox !== undefined && holder.roleMailbox !== ""
            ? { roleMailbox: holder.roleMailbox }
            : {}),
          ...(holder.phone !== undefined && holder.phone !== "" ? { phone: holder.phone } : {}),
          ...(holder.signatory !== undefined ? { signatory: holder.signatory } : {}),
        },
      });
      if (response.ok) {
        setSaved(true);
        return;
      }
      setError(t(locale, "web.common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function saveBudget(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const csrfToken = await fetchSessionCsrfToken();
      if (csrfToken === null) {
        setError(t(locale, "errors.unauthenticated"));
        return;
      }
      const { response } = await api.PUT("/settings/budget", {
        params: { header: { "X-Patrol-CSRF": csrfToken } },
        body: {
          engineCaps: holder.acquisitionBudget.engineCaps.map((cap) => ({
            ...cap,
            currency: "usd" as const,
          })),
          recheckSharePercent: holder.acquisitionBudget.recheckSharePercent,
        },
      });
      if (response.ok) {
        setSaved(true);
        await load();
        return;
      }
      setError(t(locale, "web.common.error"));
    } finally {
      setBusy(false);
    }
  }

  const cap = (engine: "google" | "bing" | "yandex") =>
    holder.acquisitionBudget.engineCaps.find((row) => row.engine === engine)?.monthlyCapMinor ?? 0;
  const setCap = (engine: "google" | "bing" | "yandex", value: number) =>
    setHolder({
      ...holder,
      acquisitionBudget: {
        ...holder.acquisitionBudget,
        engineCaps: [
          { engine: "google", monthlyCapMinor: engine === "google" ? value : cap("google") },
          { engine: "bing", monthlyCapMinor: engine === "bing" ? value : cap("bing") },
          { engine: "yandex", monthlyCapMinor: engine === "yandex" ? value : cap("yandex") },
        ],
      },
    });

  return (
    <main>
      <h1>{t(locale, "web.settings.title")}</h1>
      <p>
        <Link to="/settings/allowlist">{t(locale, "web.settings.allowlist.title")}</Link>
        {" · "}
        <Link to="/settings/recipient-profiles">
          {t(locale, "web.settings.profiles.title")}
        </Link>
      </p>
      {error !== null && <p role="alert">{error}</p>}
      {saved && <p role="status">{t(locale, "web.common.saved")}</p>}

      <section>
        <h2>{t(locale, "web.settings.rightsHolder.title")}</h2>
        {isAdmin ? (
          <form onSubmit={saveHolder}>
            <label>
              {t(locale, "web.settings.rightsHolder.legalName")}
              <input
                value={holder.legalName}
                onChange={(e) => setHolder({ ...holder, legalName: e.target.value })}
                required
              />
            </label>
            <label>
              {t(locale, "web.settings.rightsHolder.country")}
              <input
                value={holder.country}
                onChange={(e) => setHolder({ ...holder, country: e.target.value })}
                required
                pattern="[A-Z]{2}"
              />
            </label>
            <label>
              {t(locale, "web.settings.rightsHolder.roleMailbox")}
              <input
                type="email"
                value={holder.roleMailbox ?? ""}
                onChange={(e) => setHolder({ ...holder, roleMailbox: e.target.value })}
              />
            </label>
            <label>
              {t(locale, "web.settings.rightsHolder.phone")}
              <input
                value={holder.phone ?? ""}
                onChange={(e) => setHolder({ ...holder, phone: e.target.value })}
              />
            </label>
            <h3>{t(locale, "web.settings.signatory.title")}</h3>
            <label>
              {t(locale, "web.settings.signatory.fullName")}
              <input
                value={holder.signatory?.fullLegalName ?? ""}
                onChange={(e) =>
                  setHolder({
                    ...holder,
                    signatory: {
                      fullLegalName: e.target.value,
                      authorityBasis: holder.signatory?.authorityBasis ?? "",
                      contactEmail: holder.signatory?.contactEmail ?? "",
                    },
                  })
                }
              />
            </label>
            <label>
              {t(locale, "web.settings.signatory.authorityBasis")}
              <input
                value={holder.signatory?.authorityBasis ?? ""}
                onChange={(e) =>
                  setHolder({
                    ...holder,
                    signatory: {
                      fullLegalName: holder.signatory?.fullLegalName ?? "",
                      authorityBasis: e.target.value,
                      contactEmail: holder.signatory?.contactEmail ?? "",
                    },
                  })
                }
              />
            </label>
            <label>
              {t(locale, "web.settings.signatory.contactEmail")}
              <input
                type="email"
                value={holder.signatory?.contactEmail ?? ""}
                onChange={(e) =>
                  setHolder({
                    ...holder,
                    signatory: {
                      fullLegalName: holder.signatory?.fullLegalName ?? "",
                      authorityBasis: holder.signatory?.authorityBasis ?? "",
                      contactEmail: e.target.value,
                    },
                  })
                }
              />
            </label>
            <button type="submit" disabled={busy}>
              {t(locale, "web.common.save")}
            </button>
          </form>
        ) : (
          <dl>
            <dt>{t(locale, "web.settings.rightsHolder.legalName")}</dt>
            <dd>{holder.legalName}</dd>
            <dt>{t(locale, "web.settings.signatory.fullName")}</dt>
            <dd>{holder.signatory?.fullLegalName ?? "—"}</dd>
          </dl>
        )}
      </section>

      <section>
        <h2>{t(locale, "web.settings.budget.title")}</h2>
        {isAdmin ? (
          <form onSubmit={saveBudget}>
            <label>
              {t(locale, "web.settings.budget.googleCap")}
              <input
                inputMode="numeric"
                value={cap("google")}
                onChange={(e) => setCap("google", Number.parseInt(e.target.value, 10) || 0)}
              />
            </label>
            <label>
              {t(locale, "web.settings.budget.yandexCap")}
              <input
                inputMode="numeric"
                value={cap("yandex")}
                onChange={(e) => setCap("yandex", Number.parseInt(e.target.value, 10) || 0)}
              />
            </label>
            <label>
              {t(locale, "web.settings.budget.bingCap")}
              <input
                inputMode="numeric"
                value={cap("bing")}
                onChange={(e) => setCap("bing", Number.parseInt(e.target.value, 10) || 0)}
              />
            </label>
            <label>
              {t(locale, "web.settings.budget.recheckShare")}
              <input
                inputMode="numeric"
                value={holder.acquisitionBudget.recheckSharePercent}
                onChange={(e) =>
                  setHolder({
                    ...holder,
                    acquisitionBudget: {
                      ...holder.acquisitionBudget,
                      recheckSharePercent: Number.parseInt(e.target.value, 10) || 0,
                    },
                  })
                }
              />
            </label>
            <button type="submit" disabled={busy}>
              {t(locale, "web.settings.budget.submit")}
            </button>
          </form>
        ) : (
          <p>
            Google {cap("google")} · Yandex {cap("yandex")} · Bing {cap("bing")} ·{" "}
            {holder.acquisitionBudget.recheckSharePercent}%
          </p>
        )}

        <h3>{t(locale, "web.settings.capacity.title")}</h3>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <label>
            {t(locale, "web.settings.capacity.locales")}
            <input
              inputMode="numeric"
              value={capacityLocales}
              onChange={(e) => setCapacityLocales(e.target.value)}
            />
          </label>
          <label>
            {t(locale, "web.settings.capacity.cadence")}
            <select
              value={capacityCadence}
              onChange={(e) =>
                setCapacityCadence(
                  e.target.value as "daily" | "every_other_day" | "weekly",
                )
              }
            >
              {(["daily", "every_other_day", "weekly"] as const).map((cadence) => (
                <option key={cadence} value={cadence}>
                  {t(locale, CADENCE_MESSAGES[cadence])}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">{t(locale, "web.settings.capacity.compute")}</button>
        </form>
        {capacity !== null && (
          <dl>
            <dt>{t(locale, "web.settings.capacity.queriesPerScan")}</dt>
            <dd>{capacity.queriesPerTitlePerScan}</dd>
            <dt>{t(locale, "web.settings.capacity.supported")}</dt>
            <dd>{capacity.supportedTitles}</dd>
            <dt>{t(locale, "web.settings.capacity.tracked")}</dt>
            <dd>{capacity.trackedTitles}</dd>
            <dt>{t(locale, "web.settings.capacity.shortfall")}</dt>
            <dd>{capacity.shortfallTitles}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}
