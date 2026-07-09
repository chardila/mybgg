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
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Generated content"
    gemini_provider = MagicMock()

    sections, failures = compile_game(
        GAME_DATA, rulebook_text=None, pdf_bytes=None,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert set(sections.keys()) == {"index", "setup", "rules", "teaching", "faq", "glossary"}
    assert failures == []
    assert deepseek_provider.generate.call_count == 6
    gemini_provider.generate.assert_not_called()
    gemini_provider.generate_multimodal.assert_not_called()


def test_compile_game_with_rulebook_but_no_pdf_bytes_uses_text_path():
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Content from rulebook"
    gemini_provider = MagicMock()

    sections, failures = compile_game(
        GAME_DATA, rulebook_text="Chapter 1: Setup...", pdf_bytes=None,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    call_args = deepseek_provider.generate.call_args_list
    all_prompts = " ".join(str(call) for call in call_args)
    assert "Chapter 1: Setup" in all_prompts
    gemini_provider.generate.assert_not_called()
    gemini_provider.generate_multimodal.assert_not_called()


def test_compile_game_continues_on_section_failure():
    deepseek_provider = MagicMock()
    deepseek_provider.generate.side_effect = [
        Exception("API error"),  # index fails
        "# Setup content",       # setup succeeds (no pdf_bytes -> text path)
        "# Rules content",       # rules succeeds (no pdf_bytes -> text path)
        "# Teaching content",
        "# FAQ content",
        "# Glossary content",
    ]
    gemini_provider = MagicMock()

    sections, failures = compile_game(
        GAME_DATA, rulebook_text=None, pdf_bytes=None,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert "index" in failures
    assert "setup" in sections
    assert sections["setup"] == "# Setup content"
    assert len(failures) == 1


def test_compile_game_includes_edition_in_prompts():
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "content"
    gemini_provider = MagicMock()
    game_data_with_edition = {**GAME_DATA, "edition": "2018", "yearpublished": 2018}

    compile_game(
        game_data_with_edition, rulebook_text=None, pdf_bytes=None,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    all_prompts = " ".join(str(call) for call in deepseek_provider.generate.call_args_list)
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


def _make_pdf_bytes(num_pages: int) -> bytes:
    import io
    from pypdf import PdfWriter
    writer = PdfWriter()
    for _ in range(num_pages):
        writer.add_blank_page(width=72, height=72)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_compile_game_uses_multimodal_chapters_when_outline_succeeds():
    pdf_bytes = _make_pdf_bytes(6)
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Text section"
    gemini_provider = MagicMock()
    gemini_provider.generate.return_value = json.dumps([
        {"titulo": "Turn Structure", "paginas": [1, 3]},
        {"titulo": "Scoring", "paginas": [4, 6]},
    ])
    gemini_provider.generate_multimodal.return_value = "# Chapter content"

    sections, failures = compile_game(
        GAME_DATA, rulebook_text="Full rulebook text", pdf_bytes=pdf_bytes,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert failures == []
    assert set(sections.keys()) == {"index", "setup", "rules", "teaching", "faq", "glossary"}
    assert sections["rules"] == "# Chapter content\n\n# Chapter content"
    assert gemini_provider.generate_multimodal.call_count == 3  # 2 rules chapters + setup
    assert deepseek_provider.generate.call_count == 4  # index, teaching, faq, glossary
    assert gemini_provider.generate.call_count == 1  # outline pass


def test_compile_game_setup_uses_full_pdf_not_a_slice():
    pdf_bytes = _make_pdf_bytes(4)
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Text section"
    gemini_provider = MagicMock()
    gemini_provider.generate.return_value = json.dumps([{"titulo": "All Rules", "paginas": [1, 4]}])
    gemini_provider.generate_multimodal.return_value = "# Content"

    compile_game(
        GAME_DATA, rulebook_text="Full rulebook text", pdf_bytes=pdf_bytes,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    pdf_args = [call.args[2] for call in gemini_provider.generate_multimodal.call_args_list]
    assert pdf_bytes in pdf_args  # setup call used the unmodified full PDF


def test_compile_game_falls_back_to_text_when_outline_pass_fails():
    pdf_bytes = _make_pdf_bytes(3)
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Text rules"
    gemini_provider = MagicMock()
    gemini_provider.generate.return_value = "not valid json"
    gemini_provider.generate_multimodal.return_value = "# Setup content"

    sections, failures = compile_game(
        GAME_DATA, rulebook_text="Full rulebook text", pdf_bytes=pdf_bytes,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert failures == []
    assert sections["rules"] == "# Text rules"
    assert deepseek_provider.generate.call_count == 5  # index, teaching, faq, glossary, rules fallback
    gemini_provider.generate_multimodal.assert_called_once()  # setup only


def test_compile_game_continues_when_one_rules_chapter_fails():
    pdf_bytes = _make_pdf_bytes(4)
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Text section"
    gemini_provider = MagicMock()
    gemini_provider.generate.return_value = json.dumps([
        {"titulo": "Part A", "paginas": [1, 2]},
        {"titulo": "Part B", "paginas": [3, 4]},
    ])
    gemini_provider.generate_multimodal.side_effect = [
        "# Setup content",          # setup call (compile_game processes setup before rules)
        Exception("gemini error"),  # Part A fails
        "# Part B content",         # Part B succeeds
    ]

    sections, failures = compile_game(
        GAME_DATA, rulebook_text="Full rulebook text", pdf_bytes=pdf_bytes,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert sections["rules"] == "# Part B content"
    assert sections["setup"] == "# Setup content"
    assert any("Part A" in f for f in failures)


def test_compile_game_falls_back_to_text_when_all_rules_chapters_fail():
    pdf_bytes = _make_pdf_bytes(2)
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Text section"
    gemini_provider = MagicMock()
    gemini_provider.generate.return_value = json.dumps([{"titulo": "Part A", "paginas": [1, 2]}])
    gemini_provider.generate_multimodal.side_effect = Exception("boom")

    sections, failures = compile_game(
        GAME_DATA, rulebook_text="Full rulebook text", pdf_bytes=pdf_bytes,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert sections["rules"] == "# Text section"  # fell back to DeepSeek text generation
    assert any("Part A" in f for f in failures)  # chapter failure still recorded
    assert "setup" in failures  # same side_effect exception raised for the setup call too


def test_compile_game_rules_survives_out_of_range_page_numbers():
    pdf_bytes = _make_pdf_bytes(3)
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Fallback text rules"
    gemini_provider = MagicMock()
    gemini_provider.generate.return_value = json.dumps([
        {"titulo": "Out of Range", "paginas": [10, 20]},
    ])
    gemini_provider.generate_multimodal.return_value = "# Setup content"

    sections, failures = compile_game(
        GAME_DATA, rulebook_text="Full rulebook text", pdf_bytes=pdf_bytes,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert "rules" in sections
