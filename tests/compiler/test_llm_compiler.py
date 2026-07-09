from unittest.mock import MagicMock
from compiler.llm_compiler import compile_game
import json


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


def test_compile_game_includes_edition_in_prompts():
    provider = MagicMock()
    provider.generate.return_value = "content"
    game_data_with_edition = {**GAME_DATA, "edition": "2018", "yearpublished": 2018}

    compile_game(game_data_with_edition, rulebook_text=None, provider=provider)

    all_prompts = " ".join(str(call) for call in provider.generate.call_args_list)
    assert "2018" in all_prompts


def test_no_rulebook_block_includes_edition_and_game_name():
    from compiler.llm_compiler import _rulebook_block
    game_data = {**GAME_DATA, "edition": "kickstarter", "name": "Root"}
    result = _rulebook_block(None, game_data)
    assert "kickstarter" in result
    assert "Root" in result
    assert "general knowledge" in result
    assert "uncertainty" in result


def test_rulebook_block_with_text_ignores_edition():
    from compiler.llm_compiler import _rulebook_block
    game_data = {**GAME_DATA, "edition": "kickstarter"}
    result = _rulebook_block("Chapter 1: Setup...", game_data)
    assert "Chapter 1: Setup" in result
    assert "general knowledge" not in result


EXPANSION_DATA = {
    **GAME_DATA,
    "name": "Pandemic: In the Lab",
    "is_expansion": True,
    "base_game_name": "Pandemic",
    "edition": "2014",
}


def test_expansion_block_is_empty_for_base_game():
    from compiler.llm_compiler import _expansion_block
    result = _expansion_block({**GAME_DATA, "is_expansion": False})
    assert result == ""


def test_expansion_block_contains_base_game_name():
    from compiler.llm_compiler import _expansion_block
    result = _expansion_block(EXPANSION_DATA)
    assert "Pandemic" in result
    assert "expansion" in result.lower()
    assert "do not repeat" in result.lower() or "focus exclusively" in result.lower()


def test_all_prompts_include_expansion_block():
    from compiler.llm_compiler import _prompts
    prompts = _prompts(EXPANSION_DATA, rulebook_text=None)
    for section, prompt_text in prompts.items():
        assert "Pandemic" in prompt_text, f"expansion block missing from '{section}' prompt"


def test_base_game_prompts_have_no_expansion_block():
    from compiler.llm_compiler import _prompts
    game_data = {**GAME_DATA, "is_expansion": False, "edition": "2018"}
    prompts = _prompts(game_data, rulebook_text=None)
    for section, prompt_text in prompts.items():
        assert "expansion" not in prompt_text.lower() or "expansion" in prompt_text.lower() and "Focus exclusively" not in prompt_text, \
            f"expansion block unexpectedly found in '{section}' prompt"


def test_plan_rules_outline_parses_valid_json():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.return_value = json.dumps([
        {"titulo": "Turn Structure", "paginas": [1, 3]},
        {"titulo": "Combat", "paginas": [4, 6]},
    ])
    result = plan_rules_outline("some rulebook text", provider)
    assert result == [
        {"titulo": "Turn Structure", "paginas": [1, 3]},
        {"titulo": "Combat", "paginas": [4, 6]},
    ]


def test_plan_rules_outline_strips_markdown_fences():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.return_value = (
        '```json\n[{"titulo": "Combat", "paginas": [1, 2]}]\n```'
    )
    result = plan_rules_outline("text", provider)
    assert result == [{"titulo": "Combat", "paginas": [1, 2]}]


def test_plan_rules_outline_returns_none_on_malformed_json():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.return_value = "not json at all"
    assert plan_rules_outline("text", provider) is None


def test_plan_rules_outline_returns_none_on_empty_array():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.return_value = "[]"
    assert plan_rules_outline("text", provider) is None


def test_plan_rules_outline_returns_none_when_provider_raises():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.side_effect = Exception("network error")
    assert plan_rules_outline("text", provider) is None


def test_plan_rules_outline_filters_invalid_chapters_but_keeps_valid_ones():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.return_value = json.dumps([
        {"titulo": "Bad", "paginas": "not-a-list"},
        {"titulo": "Good", "paginas": [1, 2]},
    ])
    result = plan_rules_outline("text", provider)
    assert result == [{"titulo": "Good", "paginas": [1, 2]}]


def test_plan_rules_outline_merges_down_to_cap():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    chapters = [{"titulo": f"Ch{i}", "paginas": [i, i]} for i in range(1, 11)]
    provider.generate.return_value = json.dumps(chapters)
    result = plan_rules_outline("text", provider)
    assert len(result) == 8


def test_merge_chapters_to_cap_preserves_page_coverage():
    from compiler.llm_compiler import _merge_chapters_to_cap
    chapters = [{"titulo": f"Ch{i}", "paginas": [i, i]} for i in range(1, 5)]
    result = _merge_chapters_to_cap(chapters, 2)
    assert len(result) == 2
    assert result[0]["paginas"][0] == 1
    assert result[-1]["paginas"][1] == 4
