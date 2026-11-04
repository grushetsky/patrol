-- The migration ledger every later migration records itself in (ADR 0028).
-- One row: the highest applied forward-only migration number, when it was
-- applied, and its file name. Startup refuses when the stamp and the image
-- disagree.
CREATE TABLE patrol_meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL,
  applied_at timestamp with time zone NOT NULL DEFAULT now(),
  name text NOT NULL
);

INSERT INTO patrol_meta (singleton, schema_version, applied_at, name)
VALUES (true, 0, now(), '0000_meta');
