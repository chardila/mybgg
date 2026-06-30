from unittest.mock import MagicMock, patch
import pytest
from compiler.bgg_fetcher import fetch_game, _to_slug


BGG_GAME_DATA = {
    "id": 237182,
    "type": "boardgame",
    "name": "Root",
    "description": "A game of adventure and war.",
    "mechanics": ["Area Control", "Hand Management"],
    "categories": ["Animals", "Fighting"],
    "suggested_numplayers": [("2", "best"), ("3", "recommended")],
    "min_players": "2",
    "max_players": "4",
    "weight": "3.72",
    "rank": "21",
    "playing_time": "60",
    "usersrated": "50000",
    "numowned": "100000",
    "rating": "8.1",
    "expansions": [],
    "yearpublished": "2018",
}


def test_fetch_game_returns_dict():
    with patch("compiler.bgg_fetcher.BGGClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.game_list.return_value = [BGG_GAME_DATA]
        mock_cls.return_value = mock_client

        result = fetch_game(237182)

    assert result["id"] == 237182
    assert result["name"] == "Root"
    assert result["slug"] == "root"
    assert result["mechanics"] == ["Area Control", "Hand Management"]
    assert result["players"] == "2-4"


def test_fetch_game_raises_for_unknown_id():
    with patch("compiler.bgg_fetcher.BGGClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.game_list.return_value = []
        mock_cls.return_value = mock_client

        with pytest.raises(ValueError, match="not found"):
            fetch_game(999999)


def test_to_slug_simple():
    assert _to_slug("Root") == "root"


def test_to_slug_with_spaces():
    assert _to_slug("Terraforming Mars") == "terraforming-mars"


def test_to_slug_with_special_chars():
    assert _to_slug("Arkham Horror: The Card Game") == "arkham-horror-the-card-game"


def test_fetch_game_includes_yearpublished():
    with patch("compiler.bgg_fetcher.BGGClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.game_list.return_value = [BGG_GAME_DATA]
        mock_cls.return_value = mock_client
        result = fetch_game(237182)
    assert result["yearpublished"] == 2018


def test_fetch_game_yearpublished_defaults_to_zero():
    data_no_year = {k: v for k, v in BGG_GAME_DATA.items() if k != "yearpublished"}
    with patch("compiler.bgg_fetcher.BGGClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.game_list.return_value = [data_no_year]
        mock_cls.return_value = mock_client
        result = fetch_game(237182)
    assert result["yearpublished"] == 0
