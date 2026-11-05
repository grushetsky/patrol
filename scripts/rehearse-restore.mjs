#!/usr/bin/env node
// The backup/restore rehearsal (docs/runbooks/backup-restore.md): a timed,
// end-to-end drill against the compose test topology that proves the
// recovery path — dump, copy, destroy, restore, boot, fetch — rather than
// the existence of backups. `pnpm run rehearse:restore` runs it; the
// quarterly drill and any change touching the migration chain or the store
// layout re-runs it.
//
// Phases, each timed against the four-hour RTO the design fixes:
//   stack    docker-compose.test.yml up (db-test :5433, minio-test :9002)
//   migrate  the API image's migrate task applies the forward-only chain
//   seed     one rights holder, operator, capture, evidence row, artifact
//            row, and the artifact's bytes in the bucket
//   backup   pg_dump inside the container + the object's bytes to a file
//   destroy  drop schema public cascade + every object version in the bucket
//   restore  the dump through psql + the object bytes back into the bucket
//   boot     the API boots against the restored database (the schema-stamp
//            check at boot IS the assertion), /health and /system/version
//   verify   a presigned GET of the artifact fetches bytes whose SHA-256
//            matches both the seeded value and the restored row
//
// The stack is torn down at the end unless --keep is passed. Nothing here
// touches the dev topology (ports 5432/9000) or any production system.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COMPOSE = ["docker", "compose", "-f", "docker-compose.test.yml"];
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://patrol:patrol@127.0.0.1:5433/patrol_test";
const S3 = {
  endpoint: "http://127.0.0.1:9002",
  region: "us-east-1",
  bucket: "patrol-evidence",
  credentials: { accessKeyId: "patrolminio", secretAccessKey: "patrolminio" },
};
const API_PORT = process.env.REHEARSE_API_PORT ?? "8731";
const RTO_MS = 4 * 60 * 60 * 1000;

// `pg` and the AWS SDK v3 clients resolve from the workspace packages that
// declare them; the script itself stays dependency-free at the root.
const workerRequire = createRequire(join(ROOT, "apps/worker/package.json"));
const { Pool } = workerRequire("pg");
const evidenceRequire = createRequire(join(ROOT, "packages/evidence/package.json"));
const {
  S3Client,
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
} = evidenceRequire("@aws-sdk/client-s3");
const { getSignedUrl } = evidenceRequire("@aws-sdk/s3-request-presigner");

const ARTIFACT_KIND = "response_body";
/** The store's content-addressed layout (packages/evidence store.ts). */
const artifactKey = (kind, sha256) =>
  `evidence/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;

const timings = [];
const failures = [];
let currentPhase = "";
const phaseStart = (name) => {
  currentPhase = name;
  phaseStartAt = performance.now();
  process.stdout.write(`\n== ${name}\n`);
};
const phaseEnd = (note) => {
  const ms = performance.now() - phaseStartAt;
  timings.push([currentPhase, ms]);
  if (note !== undefined) {
    process.stdout.write(`   ${note}\n`);
  }
  process.stdout.write(`   ${currentPhase} took ${formatMs(ms)}\n`);
};
let phaseStartAt = performance.now();

function formatMs(ms) {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function fail(message) {
  failures.push(`${currentPhase}: ${message}`);
  process.stdout.write(`   FAIL: ${message}\n`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
}

async function main() {
  const keep = process.argv.includes("--keep");
  const work = mkdtempSync(join(tmpdir(), "patrol-rehearse-"));
  let apiChild = null;
  const pool = new Pool({ connectionString: DB_URL });
  const s3 = new S3Client({
    endpoint: S3.endpoint,
    region: S3.region,
    forcePathStyle: true,
    credentials: S3.credentials,
  });

  const teardown = async () => {
    if (apiChild !== null && apiChild.exitCode === null) {
      apiChild.kill("SIGTERM");
      await new Promise((resolve) => {
        apiChild.once("exit", resolve);
        setTimeout(resolve, 5000).unref?.();
      });
    }
    await pool.end().catch(() => undefined);
    if (!keep) {
      try {
        run(COMPOSE[0], [...COMPOSE.slice(1), "down"], { stdio: "ignore" });
      } catch {
        // The stack may already be down; the rehearsal's verdict stands.
      }
    }
    rmSync(work, { recursive: true, force: true });
  };

  try {
    // ------------------------------------------------------------ stack
    phaseStart("stack: compose test topology up");
    run(COMPOSE[0], [...COMPOSE.slice(1), "up", "--detach", "--wait"]);
    phaseEnd("db-test healthy on :5433, minio-test healthy on :9002");

    // ---------------------------------------------------------- migrate
    phaseStart("migrate: forward-only chain onto the scratch database");
    const migrateOut = run(
      "pnpm",
      ["-C", "apps/api", "run", "db:migrate"],
      { env: { ...process.env, DATABASE_URL: DB_URL } },
    );
    phaseEnd(migrateOut.trim().split("\n").pop());

    // ------------------------------------------------------------- seed
    phaseStart("seed: one evidence record with real bytes");
    // Rehearsals re-run: start from the migrated baseline (the tests' own
    // per-file reset), so a leftover row from an earlier run cannot make
    // the drill report a false failure.
    {
      const tables = await pool.query(
        `select tablename from pg_tables where schemaname = 'public'
           and tablename <> 'patrol_meta' and tablename <> 'notice_templates'`,
      );
      if (tables.rows.length > 0) {
        const list = tables.rows.map((row) => `"${row.tablename}"`).join(", ");
        await pool.query(`truncate table ${list} restart identity cascade`);
      }
    }
    const bytes = Buffer.from(
      `<!doctype html><html><body>Patrol restore rehearsal ${new Date().toISOString()}</body></html>`,
      "utf8",
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const seeded = { evidenceId: "", captureId: "" };
    try {
      await pool.query(
        `insert into rights_holder (singleton, legal_name, country)
         values (true, 'Rehearsal Rights GmbH', 'DE')`,
      );
      const operator = await pool.query(
        `insert into operators (email, password_hash, role, state, created_at, updated_at)
         values ('rehearsal@example.test', 'x', 'operator', 'active', now(), now())
         returning id`,
      );
      void operator;
      const capture = await pool.query(
        `insert into captures (requested_url, normalized_url, reason, point_key, state, requested_at, finished_at)
         values ('https://rehearsal.example.test/page', 'rehearsal.example.test/page', 'detection',
                 'rehearsal', 'done', now(), now())
         returning id`,
      );
      seeded.captureId = capture.rows[0].id;
      const evidence = await pool.query(
        `insert into evidence
           (capture_id, requested_url, normalized_url, final_url, host, host_source, reason,
            outcome, http_status, attempt_number, observed_at, capture_profile)
         values ($1, 'https://rehearsal.example.test/page', 'rehearsal.example.test/page',
                 'https://rehearsal.example.test/page', 'rehearsal.example.test', 'landing_page',
                 'detection', 'captured', 200, 1, now(),
                 '{"userAgent":"rehearsal","viewportWidth":1280,"viewportHeight":800,"locale":"en",
                   "timezone":"UTC","javascriptEnabled":true,"blockedResourceKinds":[],
                   "navigationPolicy":"load","extractorVersion":"rehearsal/1"}'::jsonb)
         returning id`,
        [seeded.captureId],
      );
      seeded.evidenceId = evidence.rows[0].id;
      await pool.query(
        `insert into evidence_artifacts
           (evidence_id, kind, sha256, size_bytes, content_type, truncated, object_version)
         values ($1, $2, $3, $4, 'text/html', false, 'v1')`,
        [seeded.evidenceId, ARTIFACT_KIND, sha256, bytes.length],
      );
      try {
        await s3.send(new CreateBucketCommand({ Bucket: S3.bucket }));
      } catch {
        // The bucket stands from an earlier rehearsal; the destroy phase
        // empties it anyway.
      }
      await s3.send(
        new PutObjectCommand({
          Bucket: S3.bucket,
          Key: artifactKey(ARTIFACT_KIND, sha256),
          Body: bytes,
        }),
      );
      phaseEnd(`evidence ${seeded.evidenceId.slice(0, 8)}… artifact sha256 ${sha256.slice(0, 12)}…`);
    } catch (error) {
      fail(`seed did not land: ${error.message}`);
    }

    // ----------------------------------------------------------- backup
    phaseStart("backup: pg_dump + object copy");
    const dumpPath = join(work, "patrol_test.sql");
    const objectPath = join(work, "artifact.bin");
    try {
      const dump = run(COMPOSE[0], [
        ...COMPOSE.slice(1),
        "exec",
        "-T",
        "db-test",
        "pg_dump",
        "-U",
        "patrol",
        "-d",
        "patrol_test",
      ]);
      writeFileSync(dumpPath, dump);
      const stored = await s3.send(
        new GetObjectCommand({
          Bucket: S3.bucket,
          Key: artifactKey(ARTIFACT_KIND, sha256),
        }),
      );
      const storedBytes = Buffer.from(await stored.Body.transformToByteArray());
      writeFileSync(objectPath, storedBytes);
      if (createHash("sha256").update(storedBytes).digest("hex") !== sha256) {
        fail("the copied object's bytes do not hash to the seeded value");
      }
      phaseEnd(
        `dump ${(dump.length / 1024).toFixed(1)} KiB, object ${storedBytes.length} bytes`,
      );
    } catch (error) {
      fail(`backup did not land: ${error.message}`);
    }

    // ---------------------------------------------------------- destroy
    phaseStart("destroy: drop schema + empty the versioned bucket");
    try {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      // A versioned bucket needs every VERSION deleted, not just the keys.
      let versionToken;
      let versionsDeleted = 0;
      do {
        const versions = await s3.send(
          new ListObjectVersionsCommand({
            Bucket: S3.bucket,
            ...(versionToken === undefined ? {} : { KeyMarker: versionToken }),
          }),
        );
        for (const entry of [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]) {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: S3.bucket,
              Key: entry.Key,
              VersionId: entry.VersionId,
            }),
          );
          versionsDeleted += 1;
        }
        versionToken = versions.IsTruncated ? versions.NextKeyMarker : undefined;
      } while (versionToken !== undefined);
      phaseEnd(`schema dropped, ${versionsDeleted} object versions deleted`);
    } catch (error) {
      fail(`destroy did not complete: ${error.message}`);
    }

    // ---------------------------------------------------------- restore
    phaseStart("restore: the dump through psql + the object back");
    try {
      const dumpSql = readFileSync(dumpPath, "utf8");
      execFileSync(
        COMPOSE[0],
        [...COMPOSE.slice(1), "exec", "-T", "db-test", "psql", "-U", "patrol", "-d", "patrol_test", "-v", "ON_ERROR_STOP=1"],
        { cwd: ROOT, input: dumpSql, stdio: ["pipe", "ignore", "pipe"] },
      );
      const restoredBytes = readFileSync(objectPath);
      await s3.send(
        new PutObjectCommand({
          Bucket: S3.bucket,
          Key: artifactKey(ARTIFACT_KIND, sha256),
          Body: restoredBytes,
        }),
      );
      const row = await pool.query(
        "select sha256 from evidence_artifacts where evidence_id = $1",
        [seeded.evidenceId],
      );
      if (row.rows.length !== 1 || row.rows[0].sha256 !== sha256) {
        fail("the restored database does not carry the seeded artifact row");
      } else {
        phaseEnd("schema, rows, and object bytes stand again");
      }
    } catch (error) {
      fail(`restore did not complete: ${error.message}`);
    }

    // ------------------------------------------------------------- boot
    phaseStart(`boot: the API against the restored database (:${API_PORT})`);
    try {
      apiChild = spawn(
        "pnpm",
        ["-C", "apps/api", "exec", "tsx", "src/index.ts"],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            DATABASE_URL: DB_URL,
            PATROL_PORT: API_PORT,
            PATROL_OBJECT_STORE_ENDPOINT: S3.endpoint,
            PATROL_OBJECT_STORE_ACCESS_KEY: S3.credentials.accessKeyId,
            PATROL_OBJECT_STORE_SECRET_KEY: S3.credentials.secretAccessKey,
            PATROL_OBJECT_STORE_BUCKET: S3.bucket,
            PATROL_BOSS_SCHEMA: "pgboss_rehearsal",
            PATROL_LOG_LEVEL: "warn",
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let bootError = "";
      apiChild.stderr.on("data", (chunk) => {
        bootError += chunk.toString();
      });
      const health = await waitFor(
        `http://127.0.0.1:${API_PORT}/api/health`,
        30_000,
        () => apiChild.exitCode !== null ? `api exited early: ${bootError}` : null,
      );
      if (!health.ok) {
        fail(`the API did not come up healthy: ${health.reason ?? bootError.slice(0, 400)}`);
      } else {
        const version = await fetchJson(`http://127.0.0.1:${API_PORT}/api/system/version`);
        phaseEnd(
          `/api/health ok; /api/system/version: build ${version?.buildVersion ?? "?"} migration ${version?.migrationVersion ?? "?"}`,
        );
      }
    } catch (error) {
      fail(`boot did not complete: ${error.message}`);
    }

    // ----------------------------------------------------------- verify
    phaseStart("verify: fetch the evidence object through a signed URL");
    try {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: S3.bucket,
          Key: artifactKey(ARTIFACT_KIND, sha256),
        }),
        { expiresIn: 60 },
      );
      const fetched = await fetch(url);
      if (!fetched.ok) {
        fail(`the signed GET answered ${fetched.status}`);
      } else {
        const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
        const fetchedSha = createHash("sha256").update(fetchedBytes).digest("hex");
        if (fetchedSha !== sha256) {
          fail(`the fetched bytes hash to ${fetchedSha}, expected ${sha256}`);
        } else {
          phaseEnd(`signed GET ok; sha256 ${fetchedSha.slice(0, 12)}… matches the record`);
        }
      }
    } catch (error) {
      fail(`verify did not complete: ${error.message}`);
    }
  } finally {
    await teardown();
  }

  // ------------------------------------------------------------- report
  const total = timings.reduce((sum, [, ms]) => sum + ms, 0);
  process.stdout.write(`\n== rehearsal summary\n`);
  for (const [name, ms] of timings) {
    process.stdout.write(`   ${name.padEnd(12)} ${formatMs(ms)}\n`);
  }
  process.stdout.write(
    `   ${"total".padEnd(12)} ${formatMs(total)} of the 4 h RTO (${((total / RTO_MS) * 100).toFixed(2)}%)\n`,
  );
  if (failures.length > 0) {
    process.stdout.write(`\nREHEARSAL FAILED:\n`);
    for (const failure of failures) {
      process.stdout.write(`  - ${failure}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`\nREHEARSAL PASSED: restore boots the API and fetches evidence.\n`);
}

/** Polls a URL until it answers 200 or the timeout fires. */
async function waitFor(url, timeoutMs, earlyExit) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const early = earlyExit?.();
    if (early !== null && early !== undefined) {
      return { ok: false, reason: early };
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return { ok: true };
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, reason: `no 200 from ${url} within ${timeoutMs} ms` };
}

async function fetchJson(url) {
  try {
    const response = await fetch(url);
    if (response.ok) {
      return await response.json();
    }
  } catch {
    // The version report is best-effort context, not an assertion.
  }
  return null;
}

main().catch((error) => {
  process.stderr.write(`rehearsal crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
