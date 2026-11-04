import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { DataForSeoGoogleAdapter } from "./acquisition/adapters/dataforseo.js";
import { YandexAdapter } from "./acquisition/adapters/yandex.js";
import { ScanRunner } from "./acquisition/runner.js";
import { PlaywrightCapture } from "./evidence/browser.js";
import { CaptureRunner, retryDelay } from "./evidence/runner.js";
import { storeFromEnvironment } from "./evidence/store.js";
import {
  createDueRechecks,
  createDueScans,
  expireReservationsJob,
  probeBalances,
  probeRoutes,
  rollover,
  runNext,
} from "./acquisition/scheduler.js";
import type { Engine, SearchAdapter } from "./acquisition/types.js";

const ENGINE_QUEUES: Record<Engine, string> = {
  google: "scan.google",
  yandex: "scan.yandex",
};
const CONTROL_QUEUES = [
  "capture.run",
  "scan.schedule",
  "recheck.schedule",
  "budget.rollover",
  "budget.balance",
  "route.probe",
];

export interface WorkerJobs {
  boss: PgBoss;
  pool: Pool;
  stop(): Promise<void>;
}

/** Wire the pg-boss queues, cron schedules, and one worker per engine. */
export async function startJobs(connectionString: string): Promise<WorkerJobs> {
  const pool = new Pool({ connectionString });
  const boss = new PgBoss(connectionString);
  await boss.start();

  const adapters: Partial<Record<Engine, SearchAdapter>> = {};
  if (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD) {
    adapters.google = new DataForSeoGoogleAdapter({
      login: process.env.DATAFORSEO_LOGIN,
      password: process.env.DATAFORSEO_PASSWORD,
    });
  }
  if (process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID) {
    adapters.yandex = new YandexAdapter({
      apiKey: process.env.YANDEX_API_KEY,
      folderId: process.env.YANDEX_FOLDER_ID,
    });
  }
  const runner = new ScanRunner(pool, adapters);
  const browser = new PlaywrightCapture();
  const captureStore = storeFromEnvironment();
  const captureRunner = captureStore
    ? new CaptureRunner(pool, browser, captureStore)
    : undefined;

  for (const queue of [...Object.values(ENGINE_QUEUES), ...CONTROL_QUEUES]) {
    await boss.createQueue(queue, { retryLimit: 3 });
  }

  for (const engine of Object.keys(ENGINE_QUEUES) as Engine[]) {
    const queue = ENGINE_QUEUES[engine];
    await boss.work(queue, { batchSize: 1 }, async () => {
      const tried: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const next = await runNext(pool, runner, engine, { exclude: tried });
        if (!next) {
          return;
        }
        tried.push(next.id);
        if (next.state === "queued") {
          continue;
        }
      }
      await boss.send(queue, {}, { expireInSeconds: 3_600 });
    });
  }

  await boss.work(
    "capture.run",
    { batchSize: 1 },
    async ([job]) => {
      if (!captureRunner) {
        throw new Error("Evidence object storage is not configured.");
      }
      const data = job.data as {
        url: string;
        reason: "detection" | "review" | "pre_handoff";
        attempt?: number;
        trackedTitleId?: string;
        titleGroupId?: string;
        capturePoint?: string;
      };
      const result = await captureRunner.capture(data);
      if (result.captured) {
        const delay = retryDelay(
          result.outcome,
          data.attempt ?? 1,
          new Date(result.observedAt),
          new Date(),
        );
        if (delay !== undefined) {
          await boss.sendAfter(
            "capture.run",
            { ...data, attempt: (data.attempt ?? 1) + 1 },
            null,
            Math.ceil(delay / 1_000),
          );
        }
      }
    },
  );

  await boss.work("scan.schedule", { batchSize: 1 }, async () => {
    const now = new Date();
    await expireReservationsJob(pool, now);
    await createDueScans(pool, now);
    for (const queue of Object.values(ENGINE_QUEUES)) {
      await boss.send(
        queue,
        {},
        { singletonKey: "pump", singletonSeconds: 900, expireInSeconds: 3_600 },
      );
    }
  });

  await boss.work("recheck.schedule", { batchSize: 1 }, async () => {
    const now = new Date();
    await createDueRechecks(pool, now);
    for (const queue of Object.values(ENGINE_QUEUES)) {
      await boss.send(
        queue,
        {},
        { singletonKey: "pump", singletonSeconds: 900, expireInSeconds: 3_600 },
      );
    }
  });

  await boss.work("budget.rollover", { batchSize: 1 }, async () => {
    await rollover(pool, new Date());
  });

  await boss.work("budget.balance", { batchSize: 1 }, async () => {
    await probeBalances(pool, runner, adapters, new Date());
  });

  await boss.work("route.probe", { batchSize: 1 }, async () => {
    await probeRoutes(pool, adapters, new Date());
  });

  await boss.schedule("scan.schedule", "*/15 * * * *");
  await boss.schedule("recheck.schedule", "*/15 * * * *");
  await boss.schedule("budget.rollover", "0 0 1 * *");
  await boss.schedule("budget.balance", "0 6 * * *");
  await boss.schedule("route.probe", "0 * * * *");
  await boss.send("scan.schedule", {});
  await boss.send("recheck.schedule", {});

  return {
    boss,
    pool,
    async stop() {
      await boss.stop({ graceful: true });
      await browser.close();
      await pool.end();
    },
  };
}
