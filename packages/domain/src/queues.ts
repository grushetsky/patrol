/**
 * The engine queue names the API's producer and the worker's consumer
 * share (ADR 0005: one PostgreSQL for jobs). One queue per engine holds
 * concurrency at one, so a provider never sees a burst from Patrol. The
 * names live in the pure domain package so the two processes cannot drift:
 * a send lands in the queue the worker listens on by construction, and a
 * rename is a one-file change both sides compile against.
 */

/**
 * The engine queues, named for the job they run. Bing buys no route in v1,
 * but its queue stands so the engine's work has somewhere to wait the day
 * the route is added.
 */
export const ENGINE_QUEUE_NAMES = {
  google: "scan.run.google",
  yandex: "scan.run.yandex",
  bing: "scan.run.bing",
} as const;

export type EngineQueueName =
  (typeof ENGINE_QUEUE_NAMES)[keyof typeof ENGINE_QUEUE_NAMES];

/**
 * The capture queue (slice 4, docs/design/evidence-capture.md): one queue
 * for every evidentiary fetch whatever the reason, so the worker's limiter
 * — not queue placement — owns politeness. The API's producer (slice 5's
 * capture requests) and the worker's consumer share the name the way the
 * engine queues do.
 */
export const CAPTURE_QUEUE_NAME = "capture.run";
