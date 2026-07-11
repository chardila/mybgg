# Bulk Game Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an unattended driver (`scripts/compiler/bulk_import.py`) plus a `workflow_dispatch` GitHub Actions workflow (`bulk-import-games.yml`) that imports all 92 games in `coleccion_cardila_bgg_rules_full.csv` into the `mybgg-wiki` vault in one sequential run, without ever touching `add_game.py` or `import-game.yml`.

**Architecture:** A single new module invokes the existing `add_game.py` CLI once per CSV row via `subprocess.run`, in a strictly sequential loop (base games before expansions), skipping rows already present in the wiki, and never letting one game's failure stop the batch. Full rationale, KV/LLM budget math, and the CSV cleanup already done: `docs/superpowers/specs/2026-07-11-bulk-game-import-design.md`.

**Tech Stack:** Python 3.13, `pytest`, `csv` (stdlib), `subprocess` (stdlib) — no new dependencies.

## Global Constraints

- **Never modify `scripts/compiler/add_game.py` or `.github/workflows/import-game.yml`.** The bulk driver calls `add_game.py` exactly as `import-game.yml` already does — as an external CLI via subprocess — never as an imported function (except the existing, already-public, read-only `find_base_game_in_wiki`).
- CSV source is `coleccion_cardila_bgg_rules_full.csv` at the repo root (already cleaned to 92 rows this session — do not re-touch its contents as part of this plan).
- CSV columns, exact names: `id, name, type, URL, status, Confirmed`. `type` is `"juego"` or `"expansion"`. `URL` is the rulebook PDF link (may be empty for LLM-only imports, though none of the 92 current rows are).
- Tests live in `tests/compiler/`, run with `pytest tests/compiler/<file>.py -v` from the repo root with `venv` activated. `tests/conftest.py` already puts `scripts/` on `sys.path`, so `from compiler.bulk_import import ...` works without extra setup.
- Match the existing test style in `tests/compiler/test_add_game.py` and `tests/compiler/test_wiki_writer.py`: plain `pytest` functions (no test classes), `tmp_path` fixture for filesystem state, `unittest.mock.patch`/`MagicMock` for subprocess/IO isolation.
- New workflow (`bulk-import-games.yml`) reuses the exact checkout/setup steps from `.github/workflows/import-game.yml` (`mybgg` + `mybgg-wiki` checkouts, Python 3.13 with pip cache, `pip install -r scripts/requirements.txt`, git identity config for `wiki/`) and the same four secrets (`GAMECACHE_BGG_TOKEN`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `WIKI_GITHUB_TOKEN`).

---

### Task 1: `load_and_ordered_rows` — CSV loading with dependency-safe ordering

**Files:**
- Create: `scripts/compiler/bulk_import.py`
- Test: `tests/compiler/test_bulk_import.py`

**Interfaces:**
- Produces: `load_and_ordered_rows(csv_path: str) -> list[dict]` — each dict has keys `id, name, type, URL, status, Confirmed` (as returned by `csv.DictReader`). Rows with `type == "expansion"` are ordered after all rows with `type == "juego"`; relative order within each group matches the CSV's original row order.

- [ ] **Step 1: Write the failing tests**

```python
# tests/compiler/test_bulk_import.py
import csv


def _write_csv(path, rows):
    fieldnames = ["id", "name", "type", "URL", "status", "Confirmed"]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


# ── load_and_ordered_rows ────────────────────────────────────────────────────

def test_load_and_ordered_rows_puts_base_games_before_expansions(tmp_path):
    from compiler.bulk_import import load_and_ordered_rows
    csv_path = tmp_path / "games.csv"
    _write_csv(csv_path, [
        {"id": "1", "name": "Expansion A", "type": "expansion", "URL": "https://x/a.pdf", "status": "official", "Confirmed": "yes"},
        {"id": "2", "name": "Base B", "type": "juego", "URL": "https://x/b.pdf", "status": "official", "Confirmed": "yes"},
        {"id": "3", "name": "Base C", "type": "juego", "URL": "https://x/c.pdf", "status": "official", "Confirmed": "yes"},
        {"id": "4", "name": "Expansion D", "type": "expansion", "URL": "https://x/d.pdf", "status": "official", "Confirmed": "yes"},
    ])

    rows = load_and_ordered_rows(str(csv_path))

    assert [r["id"] for r in rows] == ["2", "3", "1", "4"]


def test_load_and_ordered_rows_skips_blank_id_rows(tmp_path):
    from compiler.bulk_import import load_and_ordered_rows
    csv_path = tmp_path / "games.csv"
    _write_csv(csv_path, [
        {"id": "1", "name": "Base B", "type": "juego", "URL": "https://x/b.pdf", "status": "official", "Confirmed": "yes"},
        {"id": "", "name": "", "type": "", "URL": "", "status": "", "Confirmed": ""},
    ])

    rows = load_and_ordered_rows(str(csv_path))

    assert [r["id"] for r in rows] == ["1"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/compiler/test_bulk_import.py -v`
Expected: `ModuleNotFoundError: No module named 'compiler.bulk_import'` (module doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/compiler/bulk_import.py
import csv


def load_and_ordered_rows(csv_path: str) -> list[dict]:
    with open(csv_path, newline="") as f:
        rows = [r for r in csv.DictReader(f) if r.get("id")]
    return sorted(rows, key=lambda r: r["type"] == "expansion")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/compiler/test_bulk_import.py -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/bulk_import.py tests/compiler/test_bulk_import.py
git commit -m "feat: add CSV loading and dependency-safe ordering for bulk import"
```

---

### Task 2: `already_in_wiki` — idempotency check

**Files:**
- Modify: `scripts/compiler/bulk_import.py`
- Modify: `tests/compiler/test_bulk_import.py`

**Interfaces:**
- Consumes: `find_base_game_in_wiki(wiki_path: str, bgg_id: int) -> dict | None` (already exists, unmodified, in `scripts/compiler/add_game.py`).
- Produces: `already_in_wiki(wiki_path: str, bgg_id: str) -> bool`

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/compiler/test_bulk_import.py

# ── already_in_wiki ──────────────────────────────────────────────────────────

def test_already_in_wiki_true_when_bgg_id_present(tmp_path):
    from compiler.bulk_import import already_in_wiki
    game_dir = tmp_path / "games" / "pandemic-2008"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        '---\nbgg_id: 30549\nname: "Pandemic"\nslug: pandemic-2008\n---\n'
    )

    assert already_in_wiki(str(tmp_path), "30549") is True


def test_already_in_wiki_false_when_bgg_id_absent(tmp_path):
    from compiler.bulk_import import already_in_wiki
    (tmp_path / "games").mkdir()

    assert already_in_wiki(str(tmp_path), "30549") is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/compiler/test_bulk_import.py -v`
Expected: 2 new tests FAIL with `ImportError: cannot import name 'already_in_wiki'`.

- [ ] **Step 3: Write minimal implementation**

```python
# add to scripts/compiler/bulk_import.py, after the existing import
from compiler.add_game import find_base_game_in_wiki


def already_in_wiki(wiki_path: str, bgg_id: str) -> bool:
    return find_base_game_in_wiki(wiki_path, int(bgg_id)) is not None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/compiler/test_bulk_import.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/bulk_import.py tests/compiler/test_bulk_import.py
git commit -m "feat: add wiki idempotency check for bulk import"
```

---

### Task 3: `import_one` — subprocess wrapper around `add_game.py`

**Files:**
- Modify: `scripts/compiler/bulk_import.py`
- Modify: `tests/compiler/test_bulk_import.py`

**Interfaces:**
- Produces: `import_one(row: dict, wiki_path: str, status: str) -> tuple[str, str]` — returns `("ok", "")` on subprocess exit code 0, `("failed", <last 500 chars of stderr>)` otherwise.

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/compiler/test_bulk_import.py
import sys
from unittest.mock import MagicMock, patch

# ── import_one ────────────────────────────────────────────────────────────────

def test_import_one_returns_ok_on_success():
    from compiler.bulk_import import import_one
    row = {"id": "237182", "name": "Root", "type": "juego", "URL": "https://x/root.pdf"}

    with patch("compiler.bulk_import.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stderr="")
        outcome, detail = import_one(row, "wiki", "owned")

    assert (outcome, detail) == ("ok", "")
    args = mock_run.call_args[0][0]
    assert args == [
        sys.executable, "scripts/compiler/add_game.py",
        "--bgg_id", "237182", "--status", "owned", "--wiki_path", "wiki",
        "--pdf_url", "https://x/root.pdf",
    ]


def test_import_one_omits_pdf_url_when_blank():
    from compiler.bulk_import import import_one
    row = {"id": "1", "name": "No PDF Game", "type": "juego", "URL": ""}

    with patch("compiler.bulk_import.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stderr="")
        import_one(row, "wiki", "owned")

    args = mock_run.call_args[0][0]
    assert "--pdf_url" not in args


def test_import_one_returns_failed_with_truncated_stderr():
    from compiler.bulk_import import import_one
    row = {"id": "1", "name": "Broken Game", "type": "juego", "URL": "https://x/b.pdf"}
    long_stderr = "x" * 1000

    with patch("compiler.bulk_import.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1, stderr=long_stderr)
        outcome, detail = import_one(row, "wiki", "owned")

    assert outcome == "failed"
    assert detail == long_stderr[-500:]
    assert len(detail) == 500
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/compiler/test_bulk_import.py -v`
Expected: 3 new tests FAIL with `ImportError: cannot import name 'import_one'`.

- [ ] **Step 3: Write minimal implementation**

```python
# add near the top of scripts/compiler/bulk_import.py
import subprocess
import sys

# add to scripts/compiler/bulk_import.py
def import_one(row: dict, wiki_path: str, status: str) -> tuple[str, str]:
    args = [
        sys.executable, "scripts/compiler/add_game.py",
        "--bgg_id", row["id"], "--status", status, "--wiki_path", wiki_path,
    ]
    if row["URL"]:
        args += ["--pdf_url", row["URL"]]

    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode == 0:
        return "ok", ""
    return "failed", proc.stderr[-500:]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/compiler/test_bulk_import.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/bulk_import.py tests/compiler/test_bulk_import.py
git commit -m "feat: add subprocess wrapper invoking add_game.py per row"
```

---

### Task 4: `write_summary` — results table + `$GITHUB_STEP_SUMMARY`

**Files:**
- Modify: `scripts/compiler/bulk_import.py`
- Modify: `tests/compiler/test_bulk_import.py`

**Interfaces:**
- Consumes: `results: list[tuple[str, str, str, str]]` — each tuple is `(bgg_id, name, outcome, detail)`, where `outcome` is `"ok"`, `"skipped"`, or `"failed"`.
- Produces: `write_summary(results: list[tuple[str, str, str, str]]) -> None` — prints a Markdown table and counts to stdout; if the `GITHUB_STEP_SUMMARY` env var is set, appends the same content to that file.

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/compiler/test_bulk_import.py

# ── write_summary ────────────────────────────────────────────────────────────

def test_write_summary_prints_counts(capsys):
    from compiler.bulk_import import write_summary
    results = [
        ("1", "Game A", "ok", ""),
        ("2", "Game B", "skipped", "already in wiki"),
        ("3", "Game C", "failed", "PDF extracted no text"),
    ]

    write_summary(results)

    out = capsys.readouterr().out
    assert "1 imported, 1 skipped, 1 failed" in out
    assert "Game C" in out
    assert "PDF extracted no text" in out


def test_write_summary_appends_to_github_step_summary(tmp_path, monkeypatch, capsys):
    from compiler.bulk_import import write_summary
    summary_file = tmp_path / "summary.md"
    summary_file.write_text("# existing content\n")
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_file))

    write_summary([("1", "Game A", "ok", "")])

    content = summary_file.read_text()
    assert "# existing content" in content
    assert "Game A" in content
    assert "1 imported, 0 skipped, 0 failed" in content
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/compiler/test_bulk_import.py -v`
Expected: 2 new tests FAIL with `ImportError: cannot import name 'write_summary'`.

- [ ] **Step 3: Write minimal implementation**

```python
# add near the top of scripts/compiler/bulk_import.py
import os

# add to scripts/compiler/bulk_import.py
def write_summary(results: list[tuple[str, str, str, str]]) -> None:
    imported = [r for r in results if r[2] == "ok"]
    skipped = [r for r in results if r[2] == "skipped"]
    failed = [r for r in results if r[2] == "failed"]

    lines = ["| bgg_id | name | outcome | detail |", "|---|---|---|---|"]
    for bgg_id, name, outcome, detail in results:
        detail_cell = detail.replace("\n", " ").replace("|", "\\|")
        lines.append(f"| {bgg_id} | {name} | {outcome} | {detail_cell} |")
    lines.append("")
    lines.append(f"{len(imported)} imported, {len(skipped)} skipped, {len(failed)} failed")
    summary = "\n".join(lines)

    print(summary)

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a") as f:
            f.write(summary + "\n")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/compiler/test_bulk_import.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/bulk_import.py tests/compiler/test_bulk_import.py
git commit -m "feat: add results summary output for bulk import"
```

---

### Task 5: `main()` orchestration + CLI entrypoint

**Files:**
- Modify: `scripts/compiler/bulk_import.py`
- Modify: `tests/compiler/test_bulk_import.py`

**Interfaces:**
- Consumes: `load_and_ordered_rows`, `already_in_wiki`, `import_one`, `write_summary` (all defined above, same module).
- Produces: `main(csv_path: str, wiki_path: str, status: str, limit: int | None = None, only_ids: set[str] | None = None) -> None`. CLI: `python scripts/compiler/bulk_import.py --csv <path> --wiki_path <path> --status <owned|wishlist|borrowed|friend|played|archived> [--limit N] [--only id1,id2,...]`.

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/compiler/test_bulk_import.py

# ── main orchestration ───────────────────────────────────────────────────────

def _fixture_csv(tmp_path, rows):
    csv_path = tmp_path / "games.csv"
    _write_csv(csv_path, rows)
    return str(csv_path)


def test_main_skips_rows_already_in_wiki(tmp_path):
    from compiler.bulk_import import main
    csv_path = _fixture_csv(tmp_path, [
        {"id": "1", "name": "Already There", "type": "juego", "URL": "https://x/a.pdf", "status": "official", "Confirmed": "yes"},
    ])
    wiki_path = tmp_path / "wiki"
    game_dir = wiki_path / "games" / "already-there-2020"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text('---\nbgg_id: 1\nname: "Already There"\n---\n')

    with patch("compiler.bulk_import.import_one") as mock_import_one, \
         patch("compiler.bulk_import.write_summary") as mock_summary:
        main(csv_path, str(wiki_path), "owned")

    mock_import_one.assert_not_called()
    results = mock_summary.call_args[0][0]
    assert results == [("1", "Already There", "skipped", "already in wiki")]


def test_main_continues_after_a_failed_row(tmp_path):
    from compiler.bulk_import import main
    csv_path = _fixture_csv(tmp_path, [
        {"id": "1", "name": "Fails", "type": "juego", "URL": "https://x/a.pdf", "status": "official", "Confirmed": "yes"},
        {"id": "2", "name": "Succeeds", "type": "juego", "URL": "https://x/b.pdf", "status": "official", "Confirmed": "yes"},
    ])
    wiki_path = tmp_path / "wiki"
    wiki_path.mkdir()

    with patch("compiler.bulk_import.import_one") as mock_import_one, \
         patch("compiler.bulk_import.write_summary") as mock_summary:
        mock_import_one.side_effect = [("failed", "boom"), ("ok", "")]
        main(csv_path, str(wiki_path), "owned")

    assert mock_import_one.call_count == 2
    results = mock_summary.call_args[0][0]
    assert results == [
        ("1", "Fails", "failed", "boom"),
        ("2", "Succeeds", "ok", ""),
    ]


def test_main_limit_filters_to_first_n_rows(tmp_path):
    from compiler.bulk_import import main
    csv_path = _fixture_csv(tmp_path, [
        {"id": "1", "name": "A", "type": "juego", "URL": "https://x/a.pdf", "status": "official", "Confirmed": "yes"},
        {"id": "2", "name": "B", "type": "juego", "URL": "https://x/b.pdf", "status": "official", "Confirmed": "yes"},
        {"id": "3", "name": "C", "type": "juego", "URL": "https://x/c.pdf", "status": "official", "Confirmed": "yes"},
    ])
    wiki_path = tmp_path / "wiki"
    wiki_path.mkdir()

    with patch("compiler.bulk_import.import_one", return_value=("ok", "")) as mock_import_one, \
         patch("compiler.bulk_import.write_summary"):
        main(csv_path, str(wiki_path), "owned", limit=2)

    assert mock_import_one.call_count == 2


def test_main_only_filters_by_id(tmp_path):
    from compiler.bulk_import import main
    csv_path = _fixture_csv(tmp_path, [
        {"id": "1", "name": "A", "type": "juego", "URL": "https://x/a.pdf", "status": "official", "Confirmed": "yes"},
        {"id": "2", "name": "B", "type": "juego", "URL": "https://x/b.pdf", "status": "official", "Confirmed": "yes"},
        {"id": "3", "name": "C", "type": "juego", "URL": "https://x/c.pdf", "status": "official", "Confirmed": "yes"},
    ])
    wiki_path = tmp_path / "wiki"
    wiki_path.mkdir()

    with patch("compiler.bulk_import.import_one", return_value=("ok", "")) as mock_import_one, \
         patch("compiler.bulk_import.write_summary") as mock_summary:
        main(csv_path, str(wiki_path), "owned", only_ids={"1", "3"})

    assert mock_import_one.call_count == 2
    results = mock_summary.call_args[0][0]
    assert [r[0] for r in results] == ["1", "3"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/compiler/test_bulk_import.py -v`
Expected: 4 new tests FAIL with `ImportError: cannot import name 'main'`.

- [ ] **Step 3: Write minimal implementation**

```python
# add to scripts/compiler/bulk_import.py
def main(
    csv_path: str,
    wiki_path: str,
    status: str,
    limit: int | None = None,
    only_ids: set[str] | None = None,
) -> None:
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


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Bulk-import games from a CSV into the wiki")
    parser.add_argument("--csv", type=str, required=True)
    parser.add_argument("--wiki_path", type=str, required=True)
    parser.add_argument("--status", type=str, required=True,
                         choices=["owned", "wishlist", "borrowed", "friend", "played", "archived"])
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--only", type=str, default=None,
                         help="Comma-separated bgg_id list to restrict the run to (for validation runs)")
    args = parser.parse_args()

    only_ids = set(args.only.split(",")) if args.only else None
    main(args.csv, args.wiki_path, args.status, limit=args.limit, only_ids=only_ids)
```

Note: `already_in_wiki(wiki_path, ...)` is called against the *same* `wiki_path` rows are being imported into as the loop progresses — since each `import_one` call is a blocking subprocess that only returns after `add_game.py` has committed and pushed, the next iteration's `already_in_wiki` check (for an expansion checking its base) sees the up-to-date wiki checkout on disk.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/compiler/test_bulk_import.py -v`
Expected: 13 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/bulk_import.py tests/compiler/test_bulk_import.py
git commit -m "feat: add main orchestration and CLI entrypoint for bulk import"
```

---

### Task 6: `bulk-import-games.yml` workflow

**Files:**
- Create: `.github/workflows/bulk-import-games.yml`
- Reference (read-only, do not modify): `.github/workflows/import-game.yml`

**Interfaces:**
- Consumes: `scripts/compiler/bulk_import.py`'s CLI (`--csv`, `--wiki_path`, `--status`).
- Produces: a `workflow_dispatch`-triggered GitHub Actions workflow.

- [ ] **Step 1: Write the workflow file**

```yaml
# .github/workflows/bulk-import-games.yml
name: Bulk import games to wiki

on:
  workflow_dispatch:
    inputs:
      csv_path:
        description: 'Path to the games CSV (repo-relative)'
        required: false
        type: string
        default: 'coleccion_cardila_bgg_rules_full.csv'
      status:
        description: 'Ownership status applied to every imported game'
        required: true
        type: choice
        default: 'owned'
        options:
          - owned
          - wishlist
          - borrowed
          - friend
          - played
          - archived
      limit:
        description: 'Optional: only import the first N rows (after ordering) — for validation runs'
        required: false
        type: string
        default: ''
      only:
        description: 'Optional: comma-separated bgg_id list to restrict the run to — for validation runs'
        required: false
        type: string
        default: ''

jobs:
  bulk_import:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout mybgg (code)
        uses: actions/checkout@v7

      - name: Checkout mybgg-wiki (content)
        uses: actions/checkout@v7
        with:
          repository: chardila/mybgg-wiki
          path: wiki
          token: ${{ secrets.WIKI_GITHUB_TOKEN }}

      - name: Setup Python
        uses: actions/setup-python@v6
        with:
          python-version: '3.13'
          cache: 'pip'

      - name: Install dependencies
        run: pip install -r scripts/requirements.txt

      - name: Configure git identity for wiki commits
        run: |
          git -C wiki config user.name "GitHub Actions"
          git -C wiki config user.email "actions@github.com"

      - name: Bulk import games
        env:
          GAMECACHE_BGG_TOKEN: ${{ secrets.GAMECACHE_BGG_TOKEN }}
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          CSV_PATH: ${{ inputs.csv_path }}
          STATUS: ${{ inputs.status }}
          LIMIT: ${{ inputs.limit }}
          ONLY: ${{ inputs.only }}
        run: |
          ARGS=(--csv "$CSV_PATH" --wiki_path wiki --status "$STATUS")
          if [ -n "$LIMIT" ]; then
            ARGS+=(--limit "$LIMIT")
          fi
          if [ -n "$ONLY" ]; then
            ARGS+=(--only "$ONLY")
          fi
          python scripts/compiler/bulk_import.py "${ARGS[@]}"
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/bulk-import-games.yml'))"`
Expected: no output, exit code 0 (confirms valid YAML; requires `pyyaml`, already a transitive dependency of `sync-to-kv.yml`'s Python step in `mybgg-wiki` — if not installed locally, run `pip install pyyaml` in the venv first).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/bulk-import-games.yml
git commit -m "feat: add bulk-import-games workflow"
```

---

### Task 7: Validation run, then the full 92-game run

This task is manual execution, not code — do it after Task 6 is merged.

- [ ] **Step 1: Pick 5 validation `bgg_id`s from `coleccion_cardila_bgg_rules_full.csv`**

Open the CSV and choose:
1. Any row with `type=juego` and a non-empty `URL` (common path).
2. An expansion row (`type=expansion`) whose base game is already in the wiki from a prior manual import — check `mybgg-wiki`'s `games/` directory for existing `bgg_id:` frontmatter values to confirm which base games already exist.
3. A `bgg_id` already present in the wiki (to confirm `"skipped"` behavior) — reuse the same id found in step 2's base-game check, or any other existing game.
4. A game whose `mechanics` (visible via BGG or the CSV's context) introduce something not yet in `mybgg-wiki`'s `mechanics/` directory.
5. One more `type=juego` row, for margin.

- [ ] **Step 2: Run the validation workflow**

```bash
gh workflow run bulk-import-games.yml --repo chardila/mybgg \
  -f csv_path=coleccion_cardila_bgg_rules_full.csv \
  -f status=owned \
  -f only=<id1,id2,id3,id4,id5>
```

- [ ] **Step 3: Watch it and inspect the result**

```bash
gh run watch --repo chardila/mybgg
```

Expected: job completes (green or not — check the summary regardless), and the run's Summary tab shows a table with 5 rows and correct outcomes (the pre-existing id shows `"skipped"`).

- [ ] **Step 4: Spot-check the resulting wiki state**

```bash
gh api repos/chardila/mybgg-wiki/contents/games --jq '.[].name' --repo chardila/mybgg-wiki
```

Expected: the newly-imported (non-skipped) games from the validation batch appear as new directories.

- [ ] **Step 5: Run the full unattended batch**

Only after Step 4 looks correct:

```bash
gh workflow run bulk-import-games.yml --repo chardila/mybgg \
  -f csv_path=coleccion_cardila_bgg_rules_full.csv \
  -f status=owned
```

No `-f only=` / `-f limit=` — this is the full 92-game run. Expected wall time ~2.5-3.5 hours (see budget in the design doc). Check the Summary tab afterward for the final `N imported, M skipped, K failed` counts; re-run the same command (no arguments needed) if `K > 0` — idempotency means only the failed rows will do real work the second time.

---

## Self-Review

**Spec coverage:**
- CSV loading + ordering → Task 1.
- Idempotency via `find_base_game_in_wiki` (unmodified) → Task 2.
- Subprocess invocation of unmodified `add_game.py` → Task 3.
- `$GITHUB_STEP_SUMMARY` output → Task 4.
- Orchestration, `--limit`/`--only` for the validation run, never-stop-on-failure loop → Task 5.
- New `workflow_dispatch` workflow mirroring `import-game.yml`'s setup → Task 6.
- Validation-first rollout plan → Task 7.
- KV/LLM/timing budget — already verified during brainstorming (see design doc); no separate implementation task needed, it's a precondition already satisfied by the current CSV and confirmed API billing tiers, not a piece of code.

**Placeholder scan:** none — every step has complete, concrete code or exact commands.

**Type consistency:** `row` dicts flow from `load_and_ordered_rows` (csv.DictReader output, all-string values, keys `id/name/type/URL/status/Confirmed`) through `already_in_wiki`, `import_one`, and `main` unchanged. `results` tuples are `(bgg_id: str, name: str, outcome: str, detail: str)` consistently from `main` into `write_summary`. `import_one`'s return type `tuple[str, str]` matches how `main` unpacks it (`outcome, detail = import_one(...)`).
