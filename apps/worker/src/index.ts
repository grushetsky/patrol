import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import pino from "pino";
import PgBoss from "pg-boss";
import { assertSchema, expectedSchemaStamp } from "@patrol/db";
import { S3EvidenceStore, enqueueCapture, s3ConfigFromEnv } from "@patrol/evidence";
import { loadWorkerConfig, packageVersion } from "./config.js";
import { FakeSerpAcquisitor } from "./acquisition/fake.js";
import { DataForSeoAdapter } from "./acquisition/dataforseo.js";
import { YandexAdapter } from "./acquisition/yandex.js";
import type { SerpAcquisitor } from "./acquisition/port.js";
import {
  budgetBalanceJob,
  budgetRolloverJob,
  bossDispatcher,
  captureDispatcher,
  captureRunJob,
  CAPTURE_QUEUE,
  captureRetryScheduler,
  captureSweepJob,
  CRON_JOBS,
  ENGINE_QUEUES,
  recheckScheduleJob,
  routeProbeJob,
  scanRunJob,
  scanScheduleJob,
} from "./jobs.js";
import type { ExecutorDeps } from "./scans/executor.js";
import { capturePage, launchCaptureBrowser } from "./capture/browser.js";
import { CaptureLimiter } from "./capture/limiter.js";
import type { CaptureRunnerDeps } from "./capture/runner.js";

/**
 * The worker process (docs/design/scan-scheduling.md "Jobs"; ADR 0005):
 * pg-boss queues per engine at concurrency one, the cron jobs that drive
 * discovery and the budget, and the graceful drain a deploy relies on
 * (a scan in flight finishes rather than dying with the container). The
 * cron set also carries the capture sweeper, the backstop that re-dispatches
 * due capture retries and reaps the rows a dead worker left running. Boot
 * order: database reachability, the domain schema stamp (the migrate task
 * ran first), then `boss.start()` — pg-boss creates and versions its own
 * schema and is deliberately absent from the drizzle migrations.
 */

const log = pino({
  level: process.env.PATROL_LOG_LEVEL ?? "info",
  redact: { paths: ["req.headers.cookie", "req.headers.authorization"], censor: "[redacted]" },
});

const config = loadWorkerConfig();

const pool = new Pool({ connectionString: config.databaseUrl });

/**
 * The file the compose healthcheck watches: the worker touches it every
 * 30 s and docker treats a file older than 90 s as an unhealthy process.
 * The queue heartbeat (a monitored pg-boss worker state) replaces it with
 * the deployment hardening in slice 9.
 */
const heartbeatFile = config.heartbeatFile;

function touchHeartbeat(): void {
  try {
    writeFileSync(heartbeatFile, `${Date.now()}\n`);
  } catch (error) {
    // A failed heartbeat write must never kill the worker; docker observes
    // the stale file and reports it.
    log.warn({ err: error, file: heartbeatFile }, "worker heartbeat write failed");
  }
}

/** The adapters the boot registered, keyed by engine. */
function buildAdapters(): Map<string, SerpAcquisitor> {
  const adapters = new Map<string, SerpAcquisitor>();
  if (config.fakeAdapter) {
    // Development and tests: fixture-driven, no network.
    log.warn("PATROL_FAKE_ADAPTER=1: the real acquisition routes are replaced by fixtures");
    adapters.set("google", new FakeSerpAcquisitor("google"));
    adapters.set("yandex", new FakeSerpAcquisitor("yandex"));
    return adapters;
  }
  // The transport timings are configuration, not code: one provider
  // request's timeout, the asynchronous task poll's interval, and the
  // deadline after which an unpicked-up task is treated as failed.
  const transport = {
    timeoutMs: config.upstreamTimeoutMs,
    pollIntervalMs: config.taskPollIntervalMs,
    pollDeadlineMs: config.taskPollDeadlineMs,
  };
  if (config.dataforseo !== null) {
    adapters.set(
      "google",
      new DataForSeoAdapter(
        config.dataforseo,
        transport,
        { buildVersion: packageVersion(), contactEmail: config.contactEmail ?? undefined },
      ),
    );
  } else {
    log.warn("DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD are not set: the Google route stays unconfigured");
  }
  if (config.yandex !== null) {
    adapters.set("yandex", new YandexAdapter(config.yandex, transport));
  } else {
    log.warn("YANDEX_SEARCH_API_KEY/YANDEX_FOLDER_ID are not set: the Yandex route stays unconfigured");
  }
  return adapters;
}

async function boot(): Promise<void> {
  try {
    await pool.query("select 1");
  } catch (error) {
    log.error({ err: error }, "worker cannot reach the database; refusing to start");
    process.exit(1);
  }
  log.info("worker connected to postgres");

  // ADR 0028: same startup check as the API — the worker refuses to run
  // against a schema the image does not expect (unrecorded, ahead, behind).
  let schemaStamp: number;
  try {
    schemaStamp = await assertSchema(pool, expectedSchemaStamp(process.env.PATROL_SCHEMA_STAMP));
    log.info({ schemaStamp }, "worker verified the database schema");
  } catch (error) {
    log.error(
      { err: error },
      "worker refuses to start: the database schema and the image disagree",
    );
    await pool.end().catch(() => undefined);
    process.exit(1);
  }

  // pg-boss owns its schema; boss.start() creates and migrates it. It is
  // deliberately not reflected into the drizzle migrations.
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    schema: config.bossSchema,
    // Maintenance and monitoring at defaults; job polling fast enough for
    // the fifteen-minute cadence to feel prompt without busy-waiting.
    pollingIntervalSeconds: 5,
  });
  boss.on("error", (error) => log.error({ err: error }, "pg-boss error"));
  await boss.start();
  log.info({ schema: config.bossSchema, version: packageVersion() }, "pg-boss started");

  // One queue per engine at concurrency one (batchSize 1): a provider
  // never sees a burst from Patrol. A scan.run picker may sit through the
  // query retry schedule (1/5/15 minutes) and an asynchronous provider
  // task, so its expiry is hours, not the default minutes.
  for (const queueName of Object.values(ENGINE_QUEUES)) {
    await boss.createQueue(queueName, {
      name: queueName,
      expireInSeconds: 7_200,
      retryLimit: 2,
      retryDelay: 60,
      retentionMinutes: 60 * 24,
    });
  }
  // A schedule lands in its own queue, so the cron queues exist before the
  // schedules do.
  for (const name of Object.keys(CRON_JOBS)) {
    await boss.createQueue(name, { name });
  }
  for (const [name, cron] of Object.entries(CRON_JOBS)) {
    await boss.schedule(name, cron, {});
  }

  // The capture queue (slice 4): one queue for every evidentiary fetch,
  // with no queue-level retries — the runner owns the retry matrix and
  // schedules its own delayed wake-ups, so a job that completes without a
  // captured outcome is a recorded decision, not a lost one. Expiry covers
  // the 45-second total budget with margin for the store and the record.
  await boss.createQueue(CAPTURE_QUEUE, {
    name: CAPTURE_QUEUE,
    expireInSeconds: 300,
    retryLimit: 0,
    retentionMinutes: 60 * 24,
  });

  const adapters = buildAdapters();
  const dispatch = bossDispatcher(boss);
  const dispatchCapture = captureDispatcher(boss);
  const executor: ExecutorDeps = {
    pool,
    now: config.now,
    adapters,
    retryDelaysMs: config.retryDelaysMs,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    // Candidate formation's detection captures ride the same enqueue port
    // the HTTP surface uses: its guards (allowlist, objection, freshness)
    // run before any fetch, and the dispatch wakes the capture queue.
    enqueueCapture: (input) =>
      enqueueCapture(
        { pool, now: config.now, dispatch: dispatchCapture },
        input,
      ),
    log: (message, extra) => log.info({ ...extra, worker: "scan" }, message),
  };

  await boss.work<{ engine?: "google" | "yandex" }>(
    ENGINE_QUEUES.google,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        await scanRunJob({ ...executor, dispatch }, "google", (message, extra) =>
          log.info({ ...extra, queue: ENGINE_QUEUES.google, jobId: job.id }, message),
        );
      }
    },
  );
  await boss.work<{ engine?: "google" | "yandex" }>(
    ENGINE_QUEUES.yandex,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        await scanRunJob({ ...executor, dispatch }, "yandex", (message, extra) =>
          log.info({ ...extra, queue: ENGINE_QUEUES.yandex, jobId: job.id }, message),
        );
      }
    },
  );
  await boss.work(ENGINE_QUEUES.bing, { batchSize: 1 }, async () => {
    // Bing buys no route in v1; its queue stands so the engine's work has
    // somewhere to wait the day the route is added.
  });
  for (const name of Object.keys(CRON_JOBS) as Array<keyof typeof CRON_JOBS>) {
    await boss.work(name, { batchSize: 1 }, async () => {
      const jobLog = (message: string, extra?: Record<string, unknown>) =>
        log.info({ ...extra, job: name }, message);
      switch (name) {
        case "scan.schedule":
          await scanScheduleJob({ pool, now: config.now, dispatch }, jobLog);
          break;
        case "recheck.schedule":
          await recheckScheduleJob({ pool, now: config.now, dispatch }, jobLog);
          break;
        case "capture.sweep":
          await captureSweepJob(
            { pool, now: config.now, dispatch: dispatchCapture },
            jobLog,
          );
          break;
        case "budget.rollover":
          await budgetRolloverJob({ pool, now: config.now }, jobLog);
          break;
        case "budget.balance":
          await budgetBalanceJob({ pool, now: config.now, adapters }, jobLog);
          break;
        case "route.probe":
          await routeProbeJob({ pool, now: config.now, adapters, dispatch }, jobLog);
          break;
      }
    });
  }

  // Evidence capture (slice 4): the store and the browser come up before
  // the workers do, so the first capture never races its own plumbing. The
  // limiter — one capture per host at a time, spacing between same-host
  // captures, a handful overall — is what politeness means here, and the
  // N registered workers are only the concurrency the limiter then bounds.
  const evidenceStore = new S3EvidenceStore(s3ConfigFromEnv());
  try {
    await evidenceStore.ensureReady();
  } catch (error) {
    log.error({ err: error }, "worker cannot ready the evidence bucket; refusing to start");
    await boss.stop({ close: false, graceful: true, timeout: 5_000 }).catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
  const browser = await launchCaptureBrowser();
  const limiter = new CaptureLimiter({
    overallConcurrency: config.captureConcurrency,
    sameHostSpacingMs: config.captureSameHostSpacingMs,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  });
  const captureRunner: CaptureRunnerDeps = {
    pool,
    now: config.now,
    store: evidenceStore,
    fetchPage: (url) => capturePage(browser, url, config.captureProfile),
    limiter,
    scheduleRetry: captureRetryScheduler(boss, config.now),
    profile: config.captureProfile,
    retryDelaysMs: config.captureRetryDelaysMs,
  };
  for (let worker = 0; worker < config.captureConcurrency; worker += 1) {
    await boss.work<{ captureId: string }>(CAPTURE_QUEUE, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        await captureRunJob(
          captureRunner,
          job.data.captureId,
          (message, extra) => log.info({ ...extra, queue: CAPTURE_QUEUE, jobId: job.id }, message),
        );
      }
    });
  }

  log.info(
    {
      engines: [...adapters.keys()],
      cron: Object.keys(CRON_JOBS),
    },
    "worker started",
  );

  touchHeartbeat();
  const heartbeat = setInterval(() => {
    touchHeartbeat();
    log.info("worker heartbeat");
  }, 30_000);

  const shutdown = async (signal: string) => {
    clearInterval(heartbeat);
    // Drain, don't die: a scan or a capture in flight finishes inside the
    // timeout, and the deploy's worker replacement waits for it (ADR 0028
    // deploy order). A capture's total budget is 45 seconds, so a drain
    // timeout of a minute covers the slowest possible in-flight attempt.
    await boss.stop({ close: false, graceful: true, timeout: 60_000 }).catch(
      (error) => log.warn({ err: error }, "pg-boss stop reported an error"),
    );
    await browser.close().catch((error: unknown) =>
      log.warn({ err: error }, "browser close reported an error"),
    );
    await pool.end().catch(() => undefined);
    log.info(`worker stopped on ${signal}`);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

boot().catch((error) => {
  log.error({ err: error }, "worker failed to boot");
  process.exit(1);
});
