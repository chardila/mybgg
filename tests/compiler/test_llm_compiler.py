from unittest.mock import MagicMock
from compiler.llm_compiler import compile_game


GAME_DATA = {
    "id": 237182,
    "name": "Root",
    "slug": "root",
    "description": "A game of adventure.",
    "mechanics": ["Area Control"],
    "categories": ["Animals"],
    "players": "2-4",
    "min_players": 2,
    "max_players": 4,
    "weight": "3.72",
    "rank": "21",
    "playing_time": "60",
}


def test_compile_game_returns_six_sections():
    provider = MagicMock()
    provider.generate.return_value = "# Generated content"

    sections, failures = compile_game(GAME_DATA, rulebook_text=None, provider=provider)

    assert set(sections.keys()) == {"index", "setup", "rules", "teaching", "faq", "glossary"}
    assert failures == []
    assert provider.generate.call_count == 6


def test_compile_game_with_rulebook():
    provider = MagicMock()
    provider.generate.return_value = "# Content from rulebook"

    sections, failures = compile_game(GAME_DATA, rulebook_text="Chapter 1: Setup...", provider=provider)

    call_args = provider.generate.call_args_list
    # Rulebook text should appear in at least one prompt
    all_prompts = " ".join(str(call) for call in call_args)
    assert "Chapter 1: Setup" in all_prompts


def test_compile_game_continues_on_section_failure():
    provider = MagicMock()
    provider.generate.side_effect = [
        Exception("API error"),  # index fails
        "# Setup content",       # setup succeeds
        "# Rules content",
        "# Teaching content",
        "# FAQ content",
        "# Glossary content",
    ]

    sections, failures = compile_game(GAME_DATA, rulebook_text=None, provider=provider)

    assert "index" in failures
    assert "setup" in sections
    assert sections["setup"] == "# Setup content"
    assert len(failures) == 1
