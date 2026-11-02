# Patrol prototype

Throwaway UI prototype and pitch deck, kept off `main` until a decision lands. State is in memory and resets on reload.

## Run

Open "_prototype/index.html_" for the clickable service prototype, or "_prototype/pitch.html_" for the pitch deck. Both run from the file system; no build step.

Or serve them over HTTP with mise:

```bash
mise run app    # http://localhost:4173
mise run pitch  # http://localhost:4174
```

## What to Try

- Run scans from the top bar and review the new candidates.
- Confirm a violation; an allowlisted candidate refuses confirmation.
- Select open violations, draft a notice, approve it, then send it.
- Toggle siren mode in the top bar.
- In the pitch, move with the arrow keys, space, or the dots.

## Demo Data

The rights holder is Northlight Pictures. Titles, URLs, and evidence are fictional; hosts use the reserved `.example` domain.
