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


# ── import_one ────────────────────────────────────────────────────────────────

import sys
from unittest.mock import MagicMock, patch


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
