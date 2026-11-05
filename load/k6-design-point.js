// Load test at the design point (docs/plan/risks.md: 150 titles in two
// locales, a handful of operators): the three read surfaces an operator's
// working day hammers — the dashboard summary, the title chart, and the
// review queue — against a seeded design-point deployment.
//
// Running it locally:
//
//   1. Bring the stack up and seed a design-point catalogue
//      (docker compose up --build --wait, then create 150 titles across
//      2-3 groups and run enough fake-adapter scans to fill the queue).
//   2. Sign in once as an operator (the sign-in ceremony's second factor
//      is deliberately not scriptable) and copy the patrol_session cookie.
//   3. Run:
//        k6 run -e BASE_URL=http://localhost:8080 \
//               -e SESSION_COOKIE='patrol_session=…' \
//               load/k6-design-point.js
//
//   Every knob is an env var; the defaults model five operators polling
//   while they work, not a synthetic spike. Watch the rate limits:
//   the defaults sit an order of magnitude under the per-session
//   ceiling (600/min), and the script asserts p95 per endpoint.

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL ?? "http://localhost:8080";
const SESSION_COOKIE = __ENV.SESSION_COOKIE;

if (!SESSION_COOKIE) {
  throw new Error(
    "SESSION_COOKIE is required: sign in once as an operator and pass the session cookie (see the header comment)",
  );
}

// Operators working: the summary refreshes on every dashboard visit, the
// chart re-renders on window/grouping changes, the review queue pages
// through the day's candidates. Five operators is the design point's
// "a handful"; 15 minutes covers several poll cycles with think time.
const OPERATORS = Number(__ENV.OPERATORS ?? 5);
const DURATION = __ENV.DURATION ?? "15m";

export const options = {
  scenarios: {
    operators: {
      executor: "constant-vus",
      vus: OPERATORS,
      duration: DURATION,
    },
  },
  thresholds: {
    // The read model's budget at the design point (slice 8's acceptance):
    // every operator-facing read answers well inside a second, errors are
    // never expected — a 429 here means the load script outgrew the
    // per-session ceiling and should be tuned, not the deployment.
    http_req_failed: ["rate<0.01"],
    summary_p95: ["p(95)<300"],
    chart_p95: ["p(95)<500"],
    queue_p95: ["p(95)<400"],
  },
};

const summaryLatency = new Trend("summary_p95");
const chartLatency = new Trend("chart_p95");
const queueLatency = new Trend("queue_p95");

const params = {
  headers: { Cookie: SESSION_COOKIE },
};

function sleepThink(baseSeconds) {
  // Operator think time: uniform 0.5x-1.5x the base, so the five VUs never
  // align into a synthetic burst.
  const factor = 0.5 + Math.random();
  sleep(baseSeconds * factor);
}

export default function () {
  group("dashboard summary", () => {
    const response = http.get(`${BASE_URL}/api/dashboard/summary`, params);
    summaryLatency.add(response.timings.duration);
    check(response, {
      "summary answers 200": (r) => r.status === 200,
    });
  });
  sleepThink(10);

  group("title chart", () => {
    const window = [7, 14, 30][Math.floor(Math.random() * 3)];
    const grouping = ["none", "title_group", "engine", "recipient"][
      Math.floor(Math.random() * 4)
    ];
    // The contract's own names: ChartMetric serialises snake_case
    // (titles_with_violations) and the query parameter is groupBy — the
    // response's grouping fields are camelCase, the request's is not.
    const response = http.get(
      `${BASE_URL}/api/dashboard/title-chart?metric=titles_with_violations&windowDays=${window}&groupBy=${grouping}`,
      params,
    );
    chartLatency.add(response.timings.duration);
    check(response, {
      "chart answers 200": (r) => r.status === 200,
    });
  });
  sleepThink(20);

  group("review queue", () => {
    const page = 1 + Math.floor(Math.random() * 3);
    const response = http.get(
      `${BASE_URL}/api/candidates?state=pending&page=${page}&pageSize=25`,
      params,
    );
    queueLatency.add(response.timings.duration);
    check(response, {
      "queue answers 200": (r) => r.status === 200,
    });
  });
  sleepThink(30);
}
