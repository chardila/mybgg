# Bulk Game Import

**Date:** 2026-07-11
**Scope:** A one-time, unattended batch import of the games in `coleccion_cardila_bgg_rules_full.csv` into the wiki, without breaking Cloudflare Workers KV's free-tier daily write limit, without hitting LLM rate limits, and without touching the existing single-game import flow (`add_game.py`, `import-game.yml`).

---

## Problem

The user has a CSV of ~92 board games (id, name, type, rulebook PDF URL, source note) they want imported into the `mybgg-wiki` vault. The existing path is `import-game.yml`, a `workflow_dispatch` workflow that imports exactly one game per manual trigger. Running that 92 times by hand is what the user wants to avoid — they want it unattended.

Two prior incidents make "just loop it" risky without checking the math first (see memory: `project_kv_daily_limit_2026-07-10`, `project_wrangler_kv_sync_bug`):

- **2026-07-10**: a manual batch of ~15 games exhausted Cloudflare KV's free-tier limit of 1,000 writes/day, because `sync-to-kv.yml` (in `mybgg-wiki`) re-uploaded the catalog + all existing games' sections on every push. That workflow is now incremental (fixed 2026-07-11, commit `fe41b10` in `mybgg-wiki`), but the fix only reduces cost — it doesn't remove the daily cap, and this batch is ~6x larger.
- LLM call volume was never checked in that incident because the batch was small enough not to matter. At 92 games it's large enough that it needed checking (see Budget section).

## Non-goals

- **No changes to `add_game.py` or `import-game.yml`.** The user explicitly wants to keep using single-game import as-is; the bulk driver treats `add_game.py` as an external CLI, invoked via subprocess, never imported or modified.
- **No automatic retries with backoff.** A failed game is logged and left for a manual re-run of the driver (which is naturally idempotent — see below). Not worth the complexity for a one-time job.
- **No multi-day scheduling/pacing.** Confirmed unnecessary — see Budget section. If a future bulk import is much larger, that's a separate design.
- **No change to how `sync-to-kv.yml` or KV storage works.** Out of scope; already fixed as of 2026-07-11.

---

## Source data: `coleccion_cardila_bgg_rules_full.csv`

Started at 138 rows. Cleaned down to **92 games** (81 base games, 11 expansions) through this session's validation pass. Removed, and why:

| Category | Count | Reason |
|---|---|---|
| Presigned S3 URLs (`X-Amz-Expires=120`) | 11 | Confirmed dead — verified live, returns `403 Forbidden`. These are one-time BGG file-download links that expire 120 seconds after generation; already expired by the time of this session. |
| `zmangames.com` CDN hosts | 7 | Confirmed dead **server-side** — verified via direct TLS handshake. `images.zmangames.com` serves a `*.cloudfront.net` certificate (hostname mismatch); `images-cdn.zmangames.com` serves a certificate that expired 2020-03-16. Will fail from any network, including GitHub Actions. Affected: Archaeology: The Card Game, Camel Up, Carcassonne, Carcassonne: Inns & Cathedrals, Carcassonne: Traders & Builders, Citadels, Onirim. |
| BGG filepage HTML wrapper | 1 | The Magic Labyrinth — `boardgamegeek.com/filepage/...` returns the HTML landing page, not the PDF (same root problem as the presigned links, without an expiring signature). |
| Google Drive folder link | 1 | FocusX — the URL is a folder listing, not a file. The CSV's own status column already flagged this (`"pending (no PDF found)"`). |
| WAF "Access Denied" / flaky host, excluded as a precaution | 8 | Rory's Story Cubes (x3), Timeline: Events, Agricola (Revised Edition), Spirit Island — `zygomatic-games.com` and `lookout-spiele.de` both returned an identical generic "Access Denied" body to non-browser requests (likely shared WAF blocking datacenter IPs — untested from an actual GitHub Actions runner, so status is unconfirmed rather than proven dead). Spirit Island's Dropbox link resolved inconsistently between two otherwise-identical requests. |

One row fixed rather than removed: **Koala Rescue Club** — its Google Drive `/view` URL (an HTML viewer page) was rewritten to `drive.google.com/uc?export=download&id=<id>`, confirmed to return the actual PDF bytes.

No duplicate `bgg_id`s remain in the cleaned CSV.

---

## Budget: KV writes and LLM calls for 92 games

**Cloudflare KV** (free tier: 1,000 writes/day). Each `add_game.py` run does one `git push` to `mybgg-wiki`, which triggers `sync-to-kv.yml` once, incrementally:
- 1 write for `catalog`
- up to 6 writes for the imported game's sections (`index`, `setup`, `rules`, `teaching`, `faq`, `glossary`)
- for expansions, the base game's `index.md` also changes (new `## Expansions` entry) — that's a 7th changed file whose slug triggers a **re-upload of all 6 of the base game's sections**, not just the one file that changed (that's how `sync-to-kv.yml`'s per-slug section loop works)

`81 games × 7 + 11 expansions × 13 ≈ 710 writes` — comfortable margin under 1,000/day, with room for the odd retry.

**LLM calls** (`llm_compiler.py`, per game with a PDF):
- DeepSeek (`deepseek-chat`): `index`, `teaching`, `faq`, `glossary` + 1 per newly-seen mechanic ≈ 4-6 calls
- Gemini (`gemini-3.1-flash-lite`, multimodal): `setup` + outline pass + up to 8 rules-chapter calls ≈ 5-8 calls

`92 games × ~11 calls ≈ ~500 DeepSeek calls, ~550 Gemini calls` over an estimated 2-3.5 hours of wall time (sequential, no concurrency — see Architecture). Confirmed with the user: **billing is enabled on both Gemini and DeepSeek**, so there's no hard daily request cap on either — only RPM/TPM quotas far above this sequential, non-bursty call rate. No pacing needed on this axis either.

**Timing**: based on the 30 most recent real `import-game.yml` runs (`gh run list`), average 128s/game, max 203s. `92 × 128s ≈ 196 min ≈ 3.3h` — well inside GitHub Actions' 6-hour single-job limit, and this estimate already includes each game's full LLM round-trip.

**Conclusion**: a single unattended run covering all 92 games is safe on every axis checked (KV, LLM, job time). No batching across days needed.

---

## Architecture

```
bulk-import-games.yml (workflow_dispatch, one job)
  checkout mybgg
  checkout mybgg-wiki  → wiki/  (WIKI_GITHUB_TOKEN)
  setup python, pip install -r scripts/requirements.txt
  git identity config for wiki/
  python scripts/compiler/bulk_import.py \
      --csv coleccion_cardila_bgg_rules_full.csv \
      --wiki_path wiki \
      --status owned
```

One job, one sequential in-process loop — **not** 92 separate `workflow_dispatch` runs of `import-game.yml`. Two reasons this matters, not just convenience:

1. **Git race safety.** Every import ends in a `git commit` + `git push` to `mybgg-wiki` main. Parallel or interleaved runs risk non-fast-forward push failures or, worse, silently racing commits. A single sequential loop makes concurrent pushes structurally impossible.
2. **Ordering dependency.** `add_game.py` aborts if an expansion's base game isn't already present in the wiki. The driver sorts base games before expansions and processes them one at a time in the same process, so by the time an expansion is attempted, its base's commit is already on disk (and pushed).

`bulk_import.py` calls `add_game.py` via `subprocess.run(...)`, exactly the same CLI invocation `import-game.yml` already uses — the single-game import path is exercised, not reimplemented, and is left completely unmodified.

---

## Components

### `scripts/compiler/bulk_import.py` (new)

```python
import csv, subprocess, sys
from pathlib import Path
from compiler.add_game import find_base_game_in_wiki  # read-only, unmodified

def load_and_ordered_rows(csv_path: str) -> list[dict]:
    with open(csv_path, newline="") as f:
        rows = [r for r in csv.DictReader(f) if r.get("id")]
    # base games ("juego") before expansions; stable within each group
    return sorted(rows, key=lambda r: r["type"] == "expansion")

def already_in_wiki(wiki_path: str, bgg_id: str) -> bool:
    return find_base_game_in_wiki(wiki_path, int(bgg_id)) is not None

def import_one(row: dict, wiki_path: str, status: str) -> tuple[str, str]:
    args = [sys.executable, "scripts/compiler/add_game.py",
            "--bgg_id", row["id"], "--status", status, "--wiki_path", wiki_path]
    if row["URL"]:
        args += ["--pdf_url", row["URL"]]
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode == 0:
        return "ok", ""
    return "failed", proc.stderr[-500:]

def main(csv_path: str, wiki_path: str, status: str,
         limit: int | None = None, only_ids: set[str] | None = None) -> None:
    rows = load_and_ordered_rows(csv_path)
    if only_ids:
        rows = [r for r in rows if r["id"] in only_ids]
    if limit:
        rows = rows[:limit]

    results = []
    for row in rows:
        if already_in_wiki(wiki_path, row["id"]):
            results.append((row["id"], row["name"], "skipped", "already in wiki"))
            continue
        outcome, detail = import_one(row, wiki_path, status)
        results.append((row["id"], row["name"], outcome, detail))

    write_summary(results)
```

`write_summary` prints a table and, when `$GITHUB_STEP_SUMMARY` is set, appends the same table there in Markdown — visible directly on the Actions run page without digging through logs. Ends with counts: `N imported, M skipped, K failed`.

CLI flags: `--csv`, `--wiki_path`, `--status`, `--limit` (first N rows after ordering), `--only` (comma-separated `bgg_id` list) — the latter two exist solely to support the validation run below; the full unattended run uses neither.

### `.github/workflows/bulk-import-games.yml` (new)

Same checkout/setup steps as `import-game.yml` (`mybgg` + `mybgg-wiki` checkouts, Python 3.13, `pip install -r scripts/requirements.txt`, git identity config), `workflow_dispatch`-triggered, with inputs for `csv_path` (default `coleccion_cardila_bgg_rules_full.csv`) and `status` (default `owned`, same choice list as `import-game.yml`). Single step: `python scripts/compiler/bulk_import.py --csv "$CSV_PATH" --wiki_path wiki --status "$STATUS"`.

Same secrets as `import-game.yml` (`GAMECACHE_BGG_TOKEN`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `WIKI_GITHUB_TOKEN`) — `bulk_import.py` doesn't touch them directly, they pass through to each `add_game.py` subprocess via the job's `env:`.

---

## Ordering and idempotency

- **Ordering**: sort key is simply `type == "expansion"` (False sorts before True) — sufficient because this catalog's expansion hierarchy is one level deep (verified: no expansion-of-an-expansion rows).
- **Idempotency**: before importing a row, check `find_base_game_in_wiki(wiki_path, bgg_id)` (already exists in `add_game.py`, read-only, reused as-is — not modified). If found, mark `"skipped"` and move on without spending a BGG fetch, LLM call, or KV write.

This buys two things:
1. The ~14-15 games already manually imported (2026-07-10 and earlier) are skipped automatically — no need to hand-prune the CSV against current wiki state.
2. **Safe to re-run.** If the job is interrupted (runner failure, cancelled workflow) partway through, re-running `bulk_import.py` picks up exactly where it left off — every prior success already has its commit pushed to `mybgg-wiki`, so progress lives in the wiki repo's git history itself, not in a separate state file that could get lost.

---

## Error handling

- **Per-game isolation**: `subprocess.run` never raises on a non-zero exit — a bad PDF, an all-sections-failed compile, a network blip, or a missing base game all just produce `"failed"` with the last 500 chars of stderr, and the loop continues to the next row. Nothing about one game's failure can stop the batch.
- **No automatic retry/backoff.** Re-running the whole driver after the batch finishes is the retry mechanism — idempotency means only the `"failed"` (and any never-attempted) rows do real work the second time.
- **Job exit status**: the workflow step succeeds regardless of individual `"failed"` rows — the summary is the source of truth, not the job's red/green state. (Open to reconsidering this if the user later wants a failing job to page/notify on partial failure, but for a one-time unattended run reviewed manually afterward, it adds no value.)

---

## Validation plan (before the full 92-game run)

Run `bulk_import.py --only <5 ids>` first, as a normal `workflow_dispatch`, watched live, covering:

1. A base game with a PDF (the common path).
2. An expansion whose base is **already** in the wiki from a prior manual import — exercises `find_base_game_in_wiki` against real pre-existing state, not just state created by this same run.
3. A `bgg_id` already present in the wiki — confirms `"skipped"` triggers correctly and spends nothing.
4. A game introducing a mechanic not yet in `mechanics/` — exercises `generate_mechanic_description`.
5. One more game, for margin.

Only after this sample comes back clean (check `$GITHUB_STEP_SUMMARY` and the resulting wiki state) does the full run (no `--only`/`--limit`) get triggered.

---

## Testing

- `load_and_ordered_rows`: expansions sort after base games; stable order within each group.
- `already_in_wiki`: true/false against a fixture wiki directory.
- `import_one`: subprocess called with expected args (with and without a PDF URL); maps return code to `"ok"`/`"failed"` correctly.
- `main`: `--limit` and `--only` filter correctly; a `"failed"` row doesn't stop subsequent rows from being processed (mock `subprocess.run` to fail once, succeed after).

---

## Out of scope / future work

- The 27 excluded games (dead/expired links, unconfirmed WAF blocks) — re-sourcing their rulebook URLs is a separate, manual follow-up, not part of this batch.
- Multi-day pacing logic — not needed at this scale; would be a separate design if a future batch is large enough to threaten the KV or LLM budget.
- Automatic retry/backoff within a single run — deferred; re-running the driver covers it.
