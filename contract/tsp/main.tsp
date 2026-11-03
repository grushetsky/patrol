import "@typespec/http";
import "@typespec/openapi";
import "@typespec/json-schema";
import "./ids.tsp";
import "./enums.tsp";
import "./value-types.tsp";
import "./catalogue.tsp";
import "./discovery.tsp";
import "./violations.tsp";
import "./notices.tsp";
import "./operators.tsp";
import "./budget.tsp";
import "./http/models.tsp";
import "./http/system.tsp";
import "./http/auth.tsp";
import "./http/operators.tsp";
import "./http/catalogue.tsp";
import "./http/scans.tsp";
import "./http/review.tsp";
import "./http/violations.tsp";
import "./http/notices.tsp";
import "./http/dashboard.tsp";
import "./http/settings.tsp";

using TypeSpec.JsonSchema;
using TypeSpec.OpenAPI;

// One service spans two namespaces: the domain, which is the validator source,
// and HTTP, which carries routes and operations. Keeping them apart stops
// `@statusCode` from leaking into domain validators, while one OpenAPI document
// describes the whole API.
@service(#{ title: "Patrol" })
@info(#{ version: "0.1.0" })
@jsonSchema("https://patrol.example/schemas/")
namespace Patrol;
