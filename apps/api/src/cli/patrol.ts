import { Pool } from "pg";
import { loadRuntimeConfig } from "../config.js";
import { migrate, type Connectable } from "../db/migrations.js";
import { AuthService } from "../auth/service.js";

const [command, subcommand] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = flag(name) ?? process.env[`PATROL_${name.toUpperCase().replaceAll("-", "_")}`];
  if (!value) {
    console.error(`Missing --${name}.`);
    process.exit(1);
  }
  return value;
}

const config = loadRuntimeConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

try {
  await migrate(pool, config.migrationsDir);
  const auth = new AuthService(pool as unknown as Connectable);

  if (command === "bootstrap") {
    const result = await auth.bootstrap({
      legalName: required("legal-name"),
      country: required("country"),
      address: flag("address") ?? "",
      roleMailbox: flag("role-mailbox") ?? "",
      adminEmail: required("admin-email"),
    });
    console.log(`Setup token: ${result.setupToken}`);
    console.log(`Expires at: ${result.expiresAt}`);
  } else if (command === "admin" && subcommand === "recover") {
    const operator = await auth.listOperators().then((operators) =>
      operators.find((item) => item.email === required("email").toLowerCase()),
    );
    if (!operator || operator.role !== "administrator") {
      console.error("No administrator with that email.");
      process.exit(1);
    }
    const result = await auth.recoverOperator(operator.email);
    console.log(`Recovery token: ${result.setupToken}`);
    console.log(`Expires at: ${result.expiresAt}`);
  } else {
    console.error("Usage: patrol bootstrap | patrol admin recover --email <address>");
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
