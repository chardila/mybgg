import csv
import os
import subprocess
import sys

from compiler.add_game import find_base_game_in_wiki


def load_and_ordered_rows(csv_path: str) -> list[dict]:
    with open(csv_path, newline="") as f:
        rows = [r for r in csv.DictReader(f) if r.get("id")]
    return sorted(rows, key=lambda r: r["type"] == "expansion")


def already_in_wiki(wiki_path: str, bgg_id: str) -> bool:
    return find_base_game_in_wiki(wiki_path, int(bgg_id)) is not None


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
