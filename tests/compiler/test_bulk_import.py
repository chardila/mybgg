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
