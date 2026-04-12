# Keepalive Workflow Design

**Date:** 2026-04-12  
**Problem:** GitHub disables scheduled workflows after 60 days of repository inactivity (no pushes). The `index.yml` workflow uploads release assets but never commits, so the repo goes inactive.

## Solution

Add a dedicated keepalive workflow that makes an empty commit every ~60 days to keep the repository active.

## File

`.github/workflows/keepalive.yml`

## Schedule

`0 0 1 1,3,5,7,9,11 *` — runs on the 1st of every other month (January, March, May, July, September, November), giving ~60 day intervals.

## Logic

1. Checkout repo with a token that allows push
2. `git commit --allow-empty -m "chore: keepalive"`
3. `git push`

## Permissions

- `contents: write` — same as `index.yml`
- Uses `GITHUB_TOKEN` from the runner — no additional secrets required

## Trade-offs

- Adds empty commits to the git history (acceptable, clearly labeled)
- No external dependencies
- Transparent and easy to understand
