# Keepalive Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a GitHub Actions workflow that makes an empty commit every ~60 days to prevent GitHub from disabling scheduled workflows due to repository inactivity.

**Architecture:** A single new workflow file `.github/workflows/keepalive.yml` that runs on a bimonthly schedule and executes `git commit --allow-empty` + `git push` using the built-in `GITHUB_TOKEN`.

**Tech Stack:** GitHub Actions, bash

---

### Task 1: Create the keepalive workflow file

**Files:**
- Create: `.github/workflows/keepalive.yml`

**Step 1: Create the workflow file**

```yaml
name: Keepalive

on:
  schedule:
    - cron: '0 0 1 1,3,5,7,9,11 *'  # 1st of every other month
  workflow_dispatch:

jobs:
  keepalive:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Empty commit to keep repo active
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git commit --allow-empty -m "chore: keepalive"
          git push
```

**Step 2: Verify the file is valid YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/keepalive.yml'))" && echo OK`
Expected: `OK`

**Step 3: Commit and push**

```bash
git add .github/workflows/keepalive.yml
git commit -m "feat: add keepalive workflow to prevent GitHub disabling scheduled jobs"
git push
```

**Step 4: Manually trigger to verify it works**

Go to `https://github.com/chardila/mybgg/actions/workflows/keepalive.yml` and click "Run workflow". Confirm the run completes successfully and an empty commit appears in the repo history.
