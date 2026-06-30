import sys
from unittest.mock import MagicMock, patch
import pytest


GAME_DATA = {
    "id": 237182, "name": "Root", "slug": "root",
    "description": "A game.", "mechanics": ["Area Control"],
    "categories": ["Animals"], "players": "2-4",
    "min_players": 2, "max_players": 4,
    "weight": "3.72", "rank": "21", "playing_time": "60",
}

FULL_SECTIONS = {
    "index": "# Root", "setup": "Setup", "rules": "Rules",
    "teaching": "Teaching", "faq": "FAQ", "glossary": "Glossary",
}


# ── acquire_pdf unit tests ──────────────────────────────────────────────────

def test_acquire_pdf_uses_manual_url():
    from compiler.add_game import acquire_pdf
    with (
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF manual") as mock_fetch,
    ):
        pdf_bytes, source, resolved_url = acquire_pdf(GAME_DATA, "https://example.com/root.pdf", "key")

    assert pdf_bytes == b"%PDF manual"
    assert source == "pdf-manual"
    assert resolved_url == "https://example.com/root.pdf"
    mock_fetch.assert_called_once_with("https://example.com/root.pdf")


def test_acquire_pdf_uses_tavily_when_no_url():
    from compiler.add_game import acquire_pdf
    with (
        patch("compiler.add_game.search_rulebook_pdf", return_value="https://found.com/rules.pdf"),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF web") as mock_fetch,
    ):
        pdf_bytes, source, resolved_url = acquire_pdf(GAME_DATA, None, "tavily-key")

    assert pdf_bytes == b"%PDF web"
    assert source == "pdf-web"
    assert resolved_url == "https://found.com/rules.pdf"
    mock_fetch.assert_called_once_with("https://found.com/rules.pdf")


def test_acquire_pdf_falls_back_to_bgg_when_tavily_fails():
    from compiler.add_game import acquire_pdf
    with (
        patch("compiler.add_game.search_rulebook_pdf", return_value=None),
        patch("compiler.add_game.scrape_bgg_rulebook", return_value="https://bgg.com/rules.pdf"),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF bgg") as mock_fetch,
    ):
        pdf_bytes, source, resolved_url = acquire_pdf(GAME_DATA, None, "tavily-key")

    assert pdf_bytes == b"%PDF bgg"
    assert source == "pdf-bgg"
    assert resolved_url == "https://bgg.com/rules.pdf"
    mock_fetch.assert_called_once_with("https://bgg.com/rules.pdf")


def test_acquire_pdf_skips_tavily_when_no_key():
    from compiler.add_game import acquire_pdf
    with (
        patch("compiler.add_game.search_rulebook_pdf") as mock_tavily,
        patch("compiler.add_game.scrape_bgg_rulebook", return_value="https://bgg.com/rules.pdf"),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF bgg"),
    ):
        _, source, _ = acquire_pdf(GAME_DATA, None, None)

    mock_tavily.assert_not_called()
    assert source == "pdf-bgg"


def test_acquire_pdf_raises_when_nothing_found():
    from compiler.add_game import acquire_pdf
    with (
        patch("compiler.add_game.search_rulebook_pdf", return_value=None),
        patch("compiler.add_game.scrape_bgg_rulebook", return_value=None),
    ):
        with pytest.raises(RuntimeError, match="Could not find a rulebook PDF"):
            acquire_pdf(GAME_DATA, None, "tavily-key")


# ── main() integration tests ────────────────────────────────────────────────

def test_main_with_pdf_url(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA),
        patch("compiler.add_game.acquire_pdf", return_value=(b"%PDF", "pdf-manual", "https://example.com/root.pdf")),
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


def test_main_fails_when_no_pdf_found(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA),
        patch("compiler.add_game.acquire_pdf", side_effect=RuntimeError("Could not find a rulebook PDF")),
        patch("compiler.add_game.DeepSeekProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        with pytest.raises(SystemExit) as exc:
            main(bgg_id=237182, pdf_url=None, status="owned", wiki_path=str(tmp_path))
        assert exc.value.code == 1
