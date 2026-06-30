import sys
from unittest.mock import MagicMock, patch
import pytest


GAME_DATA = {
    "id": 237182, "name": "Root", "slug": "root",
    "description": "A game.", "mechanics": ["Area Control"],
    "categories": ["Animals"], "players": "2-4",
    "min_players": 2, "max_players": 4,
    "weight": "3.72", "rank": "21", "playing_time": "60",
    "yearpublished": 2018,
}

FULL_SECTIONS = {
    "index": "# Root", "setup": "Setup", "rules": "Rules",
    "teaching": "Teaching", "faq": "FAQ", "glossary": "Glossary",
}


# ── _resolve_edition unit tests ──────────────────────────────────────────────

def test_resolve_edition_uses_year_by_default():
    from compiler.add_game import _resolve_edition
    assert _resolve_edition({"yearpublished": 2018}, None) == "2018"


def test_resolve_edition_uses_override_when_provided():
    from compiler.add_game import _resolve_edition
    assert _resolve_edition({"yearpublished": 2018}, "Kickstarter Edition") == "kickstarter-edition"


def test_resolve_edition_returns_unknown_when_no_year():
    from compiler.add_game import _resolve_edition
    assert _resolve_edition({"yearpublished": 0}, None) == "unknown"


# ── main() path tests ────────────────────────────────────────────────────────

def test_main_with_pdf_url_uses_pdf_manual_source(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value="Rules text"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game") as mock_write,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GAMECACHE_BGG_TOKEN": "bgg-token"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
             status="owned", wiki_path=str(tmp_path))

    write_args = mock_write.call_args[0]
    assert write_args[4] == "pdf-manual"
    assert write_args[5] == "https://example.com/root.pdf"


def test_main_with_llm_only_path_passes_none_rulebook(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])) as mock_compile,
        patch("compiler.add_game.write_game") as mock_write,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, edition="2023 Edition",
             status="owned", wiki_path=str(tmp_path))

    compile_args = mock_compile.call_args[0]
    assert compile_args[1] is None  # rulebook_text is None
    write_args = mock_write.call_args[0]
    assert write_args[4] == "llm-only"
    assert write_args[5] is None  # no resolved_url


def test_main_exits_when_no_pdf_url_and_no_edition(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        with pytest.raises(SystemExit) as exc:
            main(bgg_id=237182, pdf_url=None, edition=None,
                 status="owned", wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_slug_includes_edition_from_year(tmp_path):
    captured = {}
    def capture_write(game_data, *args, **kwargs):
        captured["slug"] = game_data["slug"]
        captured["edition"] = game_data["edition"]

    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value="Rules"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game", side_effect=capture_write),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
             status="owned", wiki_path=str(tmp_path), edition=None)

    assert captured["slug"] == "root-2018"
    assert captured["edition"] == "2018"


def test_main_exits_when_pdf_extracts_no_text(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value=""),
        patch("compiler.add_game.DeepSeekProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        with pytest.raises(SystemExit) as exc:
            main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
                 status="owned", wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_slug_uses_edition_override(tmp_path):
    captured = {}
    def capture_write(game_data, *args, **kwargs):
        captured["slug"] = game_data["slug"]

    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game", side_effect=capture_write),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, status="owned",
             wiki_path=str(tmp_path), edition="Kickstarter")

    assert captured["slug"] == "root-kickstarter"
