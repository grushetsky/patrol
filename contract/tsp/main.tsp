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

using TypeSpec.JsonSchema;
using TypeSpec.OpenAPI;

// The domain namespace is the validator source: JSON Schema is emitted from it,
// and the HTTP namespace added by the HTTP contract ticket must stay separate so
// no `@statusCode` leaks into domain validators.
@service(#{ title: "Patrol" })
@info(#{ version: "0.1.0" })
@jsonSchema("https://patrol.example/schemas/")
namespace Patrol.Domain;
