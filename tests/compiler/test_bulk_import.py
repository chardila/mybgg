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
