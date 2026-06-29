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


def test_main_with_pdf_url(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA) as mock_fetch,
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF fake") as mock_pdf,
        patch("compiler.add_game.extract_text", return_value="Rules text") as mock_extract,
        patch("compiler.add_game.DeepSeekProvider") as mock_provider_cls,
        patch("compiler.add_game.compile_game", return_value=({"index": "# Root", "setup": "Setup", "rules": "Rules", "teaching": "Teaching", "faq": "FAQ", "glossary": "Glossary"}, [])) as mock_compile,
        patch("compiler.add_game.write_game") as mock_write,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GAMECACHE_BGG_TOKEN": "bgg-token"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
             status="owned", wiki_path=str(tmp_path))

    mock_fetch.assert_called_once_with(237182, token="bgg-token")
    mock_pdf.assert_called_once_with("https://example.com/root.pdf")
    mock_extract.assert_called_once_with(b"%PDF fake")
    mock_compile.assert_called_once()
    mock_write.assert_called_once()
    _, write_kwargs = mock_write.call_args
    assert write_kwargs.get("source") == "pdf" or mock_write.call_args[0][4] == "pdf"


def test_main_without_pdf_url(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.compile_game", return_value=({"index": "# Root", "setup": "S", "rules": "R", "teaching": "T", "faq": "F", "glossary": "G"}, [])) as mock_compile,
        patch("compiler.add_game.write_game") as mock_write,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GAMECACHE_BGG_TOKEN": ""}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, status="wishlist", wiki_path=str(tmp_path))

    # compile_game called with rulebook_text=None
    compile_args = mock_compile.call_args[0]
    assert compile_args[1] is None
    # source should be ai-generated
    write_args = mock_write.call_args[0]
    assert write_args[4] == "ai-generated"
