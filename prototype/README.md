# Patrol prototype

Throwaway UI prototype and pitch deck, kept off `main` until a decision lands. State is in memory and resets on reload.

## Run

Open "_prototype/index.html_" for the clickable service prototype, or "_prototype/pitch.html_" for the pitch deck. Both run from the file system; no build step.

Or serve them over HTTP with mise:

```bash
mise run app    # http://localhost:4173
mise run pitch  # http://localhost:4174
```

## Publish

GitHub Pages serves the "_gh-pages_" branch at https://grushetsky.github.io/patrol/. Publish the current prototype with `git subtree push --prefix prototype origin gh-pages`.

## What to Try

- Run scans from the top bar and review the new candidates.
- Confirm a violation; an allowlisted candidate refuses confirmation.
- Select open violations, draft a notice, approve it, then send it.
- Toggle siren mode in the top bar.
- Switch the interface language with EN/RU; the choice carries between the prototype and the pitch.
- Switch between dark mode and the Gruvbox light theme with the sun/moon button.
- Track detection and resolution rates in the dashboard chart; confirming a violation adds today's detection.
- Open Settings from the footer or the DeepSeek card, save a DeepSeek API key, then generate a dashboard brief.
- In the pitch, move with the arrow keys, space, or the dots.

## Demo Data

The rights holder is a fictional studio. Titles, URLs, and evidence are fictional; hosts use the reserved `.example` domain. The DeepSeek key is stored separately in the browser; the prototype calls the API directly, so use only a throwaway key.
