import { createFileRoute } from "@tanstack/react-router";
import { candidatesQuery } from "../api/queries";

/**
 * The router loader only awaits the query cache; the generated client owns the
 * fetch, its input types, and its output type.
 */
export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(candidatesQuery),
  component: ReviewQueue,
});

function ReviewQueue() {
  const page = Route.useLoaderData();
  return (
    <main>
      <h1>Review queue ({page.total})</h1>
      <ul>
        {page.items.map((candidate) => (
          <li key={candidate.id}>
            {candidate.displayTitle} — {candidate.score.toFixed(2)} —{" "}
            {candidate.host} — {candidate.lifecycle.state}
          </li>
        ))}
      </ul>
    </main>
  );
}
