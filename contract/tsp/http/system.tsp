namespace Patrol.Http;

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Patrol.Domain;

@doc("A liveness report for the load balancer.")
model HealthReport {
  @doc("The only value a healthy process returns.")
  status: "ok";
}

@doc("The running build and the database schema it expects.")
model VersionReport {
  @doc("The image's build version.")
  buildVersion: string;

  @doc("The highest forward-only migration the image carries.")
  migrationVersion: string;

  @doc("Whether the database's applied migration matches the image's expected version.")
  schemaCompatible: boolean;
}

@doc("The deployment's bootstrap state, served before any domain endpoint answers.")
model SetupState {
  @doc("Whether a rights holder and at least one administrator both exist.")
  bootstrapped: boolean;

  @doc("Whether the single rights holder has been created by `patrol bootstrap`.")
  rightsHolderConfigured: boolean;

  @doc("How many administrator accounts exist.")
  administratorCount: int32;
}

@doc("Public liveness and version reporting, consumed by the load balancer and the deployment pipeline.")
@tag("System")
@route("/health")
interface Health {
  @doc("Whether the process is alive.")
  @extension("x-patrol-roles", #["anonymous"])
  @get
  op read(): HealthReport;
}

@doc("Public system state, answered before any authenticated or domain endpoint.")
@tag("System")
@route("/system")
interface System {
  @doc("The running build, the migration it carries, and whether the database matches it.")
  @extension("x-patrol-roles", #["anonymous"])
  @get
  @route("/version")
  op version(): VersionReport | ServiceUnavailable;

  @doc("The bootstrap state, which every domain endpoint also reports when it is not ready.")
  @extension("x-patrol-roles", #["anonymous"])
  @get
  @route("/setup")
  op setup(): SetupState;
}
