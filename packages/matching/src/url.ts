const TRACKING_PARAMETERS: Record<string, true> = {
  fbclid: true,
  gclid: true,
  yclid: true,
};

/** The deduplication key of a URL; the displayed URL stays verbatim. */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  const params = [...url.searchParams.entries()]
    .filter(
      ([name]) => !name.startsWith("utm_") && !TRACKING_PARAMETERS[name],
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => (value === "" ? name : `${name}=${value}`));
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return `${host}${path}${query}`;
}

export function hostOf(raw: string): string {
  return new URL(raw).hostname.toLowerCase();
}

const MULTI_LABEL_SUFFIXES = [
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "co.kr",
  "co.in",
  "co.za",
  "com.br",
  "com.mx",
  "com.tr",
  "com.cn",
  "com.sg",
  "com.hk",
  "com.tw",
];

/** A practical eTLD+1: the last two labels, or three for a known suffix. */
export function registrableDomainOf(raw: string): string {
  const host = hostOf(raw);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !host.includes(".")) {
    return host;
  }
  const labels = host.split(".");
  const lastTwo = labels.slice(-2).join(".");
  const suffix = MULTI_LABEL_SUFFIXES.find(
    (candidate) => lastTwo === candidate,
  );
  return suffix ? labels.slice(-3).join(".") : lastTwo;
}
