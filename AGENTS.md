## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with the `gh` CLI. See "_docs/agents/issue-tracker.md_".

### Triage labels

The five canonical triage roles keep their default label strings. See "_docs/agents/triage-labels.md_".

### Domain docs

Single-context: one glossary at the repo root plus "_docs/adr/_". See "_docs/agents/domain.md_".

### Git workflow

A slice is done only after its branch is pushed, its pull request is green, and the pull request is merged. Never close a slice issue on a local commit, and never leave `main` behind the integration branch. See "_docs/agents/git-workflow.md_".
