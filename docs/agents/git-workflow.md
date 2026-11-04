# Git workflow

`main` is the deployed line. It moves only through a reviewed pull request, and every build slice lands through one.

## Branches

| Branch | Purpose | Lifetime |
| --- | --- | --- |
| `main` | Release line; protected. | Permanent. |
| `design/build-handoff` | Integration branch for the build effort; carries the design handoff and completed slices. | Until the build effort ends. |
| `slice/<number>-<slug>` | One build slice, branched from the integration branch. | Until its PR merges. |

A slice branch rebases onto `origin/design/build-handoff` before review. The integration branch rebases onto `origin/main` before its PR opens.

## Definition of done

A slice is done only when all of these hold:

1. The commits are pushed to `origin`.
2. A pull request targets `main` (or the integration branch, when the slice is not the last one).
3. CI is green on the pull request.
4. The pull request is merged.
5. The issue is closed with a comment naming the merged PR and the merge commit.

A local commit, a passing local test run, or a closed issue without a merged PR is not done. Never close a slice issue on a local commit.

## Pull requests

- Open the pull request as soon as the first commit exists, so CI runs early.
- Use the body template in `".agents/skills/pr/SKILL.md"`: summary, evidence, merge danger.
- Link the slice issue with `Closes #<n>` and the epic with `Part of #<n>`.
- Merge with `gh pr merge <n> --merge` after the checks pass; do not force-push `main`.

## Credential preflight

GitHub rejects a push that adds or changes a file under `".github/workflows/"` unless the credential has the `workflow` scope. Fine-grained personal access tokens need `Contents: Read and write` and `Workflows: Read and write` for the repository.

Before the first push of a session:

```bash
gh auth status --hostname github.com
git push --dry-run origin HEAD
```

If the push is rejected for the `workflow` scope, stop and fix the credential; do not drop the workflow file or rewrite the branch to avoid it. A classic personal access token with `repo` and `workflow` scopes, stored with `gh auth login --with-token`, is the fallback.

## Stale-line check

Before reporting completion, compare the local branch with the remote:

```bash
git fetch origin
git status --short --branch
gh pr list --state open
```

`main` must contain every merged slice. An integration branch ahead of its remote, or a closed issue without a merged PR, is an unfinished workflow, not a finished task.
