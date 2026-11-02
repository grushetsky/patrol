import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { violationsQuery } from "../api/queries";

/**
 * Router loader + TanStack Query: the loader only awaits the query cache.
 * The fetch, its input types, and its output type all come from the generated
 * OpenAPI client (`src/api/queries.ts`).
 */
export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(violationsQuery),
  component: ViolationsPage,
});

/**
 * Server-function path: validate a notice request body against the emitted
 * JSON Schema bundle before it reaches the domain layer. The Ajv validator is
 * imported lazily so the schema reader stays out of the client bundle.
 */
const createNotice = createServerFn({ method: "POST" })
  .validator((body: unknown) => body)
  .handler(async ({ data }) => {
    // Deliberately dynamic: the validator module imports `node:fs` and Ajv and
    // must not be statically pulled into the browser graph.
    const { validateCreateNotice } = await import("../server/notice-validation");
    return validateCreateNotice(data);
  });

function ViolationsPage() {
  const page = Route.useLoaderData();
  return (
    <main>
      <h1>Violations ({page.total})</h1>
      <ul>
        {page.items.map((violation) => (
          <li key={violation.id}>
            {violation.titleId} — {violation.status} — {violation.sourceUrl}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() =>
          void createNotice({
            data: { violationId: page.items[0]?.id, channel: "google" },
          })
        }
      >
        Queue DMCA notice
      </button>
    </main>
  );
}
