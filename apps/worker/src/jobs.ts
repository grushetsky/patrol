import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { DataForSeoGoogleAdapter } from "./acquisition/adapters/dataforseo.js";
import { YandexAdapter } from "./acquisition/adapters/yandex.js";
import { ScanRunner } from "./acquisition/runner.js";
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
      await pool.end();
    },
  };
}
