import csv
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
