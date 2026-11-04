#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { assertSchema } from "@patrol/db";
import { t } from "@patrol/i18n";
import type { Locale } from "@patrol/i18n";
import type { AppConfig } from "../config.js";
import { adminRecoverLastAdministrator, bootstrapDeployment } from "../domain/bootstrap.js";

/**
 * The host-level `patrol` CLI (Authentication "Bootstrap and invitation").
 * `patrol bootstrap` creates the rights holder and the invited first
 * administrator and prints the one-time setup token to stdout — the only
 * secret the command ever emits. `patrol admin recover` mints a one-time
 * reset token for the last administrator. Both require container shell
 * access, the same authority that could edit the database directly.
 */

export interface CliDeps {
  pool: Pool;
  config: AppConfig;
  /** Where phrases and the token print; injected so tests capture them. */
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface CliArguments {
  command: string;
  legalName?: string;
  country?: string;
  adminEmail?: string;
  email?: string;
  help?: boolean;
}

export function parseCliArguments(argv: string[]): CliArguments {
  const args: CliArguments = { command: argv[0] ?? "" };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--legal-name":
        args.legalName = next;
        index += 1;
        break;
      case "--country":
        args.country = next;
        index += 1;
        break;
      case "--admin-email":
        args.adminEmail = next;
        index += 1;
        break;
      case "--email":
        args.email = next;
        index += 1;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        break;
    }
  }
  return args;
}

const USAGE = `usage: patrol <command> [options]

commands:
  bootstrap      create the rights holder and the invited first administrator
  admin recover  mint a one-time reset token for an administrator

options:
  --legal-name <name>     rights holder legal name            (bootstrap; or PATROL_BOOTSTRAP_LEGAL_NAME)
  --country <CC>          ISO 3166-1 alpha-2 country         (bootstrap; or PATROL_BOOTSTRAP_COUNTRY)
  --admin-email <email>   first administrator's email         (bootstrap; or PATROL_BOOTSTRAP_ADMIN_EMAIL)
  --email <email>         administrator to recover            (admin recover; or PATROL_ADMIN_RECOVER_EMAIL)
  --help                  this text`;

/**
 * Runs one CLI invocation and returns the process exit code. The setup and
 * reset tokens print to stdout once; nothing else writes a secret.
 */
export async function runCli(
  argv: string[],
  deps: CliDeps,
  env: NodeJS.ProcessEnv = {},
): Promise<number> {
  const locale: Locale = "en";
  const args = parseCliArguments(argv);
  if (args.help || args.command === "help" || args.command === "") {
    deps.stdout(USAGE);
    return args.command === "" && !args.help ? 2 : 0;
  }

  try {
    await assertSchema(deps.pool, deps.config.schemaStamp);
  } catch {
    deps.stderr("refusing to run: the database schema does not match this image; run the migrate task first");
    return 1;
  }

  if (args.command === "bootstrap") {
    const legalName = args.legalName ?? env.PATROL_BOOTSTRAP_LEGAL_NAME;
    const country = args.country ?? env.PATROL_BOOTSTRAP_COUNTRY;
    const adminEmail = args.adminEmail ?? env.PATROL_BOOTSTRAP_ADMIN_EMAIL;
    if (!legalName || !country || !adminEmail) {
      deps.stderr("bootstrap requires --legal-name, --country, and --admin-email");
      return 2;
    }
    const outcome = await bootstrapDeployment(deps.pool, deps.config, {
      legalName,
      country,
      administratorEmail: adminEmail,
    });
    if (outcome.status === "refused") {
      deps.stderr(t(locale, "cli.bootstrap.refused"));
      return 1;
    }
    deps.stdout(t(locale, "cli.bootstrap.heading"));
    deps.stdout(t(locale, "cli.bootstrap.administrator") + adminEmail);
    deps.stdout("");
    deps.stdout(t(locale, "cli.bootstrap.tokenHeading"));
    deps.stdout(outcome.setupToken);
    deps.stdout("");
    deps.stdout(t(locale, "cli.bootstrap.tokenOnce"));
    return 0;
  }

  if (args.command === "admin" && argv[1] === "recover") {
    const email = args.email ?? env.PATROL_ADMIN_RECOVER_EMAIL;
    if (!email) {
      deps.stderr("admin recover requires --email");
      return 2;
    }
    const outcome = await adminRecoverLastAdministrator(deps.pool, deps.config, {
      email,
    });
    if (outcome.status === "no_such_administrator") {
      deps.stderr(t(locale, "cli.adminRecover.noAdministrator"));
      return 1;
    }
    if (outcome.status === "other_administrators_active") {
      deps.stderr(t(locale, "cli.adminRecover.notLastAdministrator"));
      return 1;
    }
    deps.stdout(t(locale, "cli.adminRecover.heading"));
    deps.stdout("");
    deps.stdout(t(locale, "cli.adminRecover.tokenHeading"));
    deps.stdout(outcome.resetToken);
    deps.stdout("");
    deps.stdout(t(locale, "cli.bootstrap.tokenOnce"));
    return 0;
  }

  deps.stderr(`unknown command: ${args.command}`);
  deps.stderr(USAGE);
  return 2;
}

/** The bin entry. Tests call runCli directly with injected deps instead. */
async function main(): Promise<void> {
  const { loadConfig } = await import("../config.js");
  const { Pool } = await import("pg");
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const code = await runCli(process.argv.slice(2), {
    pool,
    config,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
  await pool.end();
  process.exit(code);
}

// Run only when executed as a script, not when a test imports runCli: the
// entry module this process started and this file must be the same one.
function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  main().catch((error) => {
    console.error(`patrol cli failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
