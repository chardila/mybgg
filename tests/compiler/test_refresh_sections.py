from unittest.mock import patch
import pytest


GAME_DATA = {
    "id": 237182, "name": "Root", "slug": "root",
    "description": "A game.", "mechanics": ["Area Control"],
    "categories": ["Animals"], "players": "2-4",
    "min_players": 2, "max_players": 4,
    "weight": "3.72", "rank": "21", "playing_time": "60",
    "yearpublished": 2018,
}

TEACHING_ONLY = {"teaching": "Nuevo contenido de teaching."}


def _write_index(tmp_path, slug, extra_frontmatter=""):
    game_dir = tmp_path / "games" / slug
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        f'---\nbgg_id: 237182\nname: "Root"\nslug: {slug}\nedition: "2018"\n'
        f"{extra_frontmatter}---\n\n# Root\n"
    )
    return game_dir


# ── frontmatter reading ──────────────────────────────────────────────────────

def test_read_existing_game_extracts_bgg_id_and_edition(tmp_path):
    from compiler.refresh_sections import _read_existing_game
    _write_index(tmp_path, "root")
    result = _read_existing_game(str(tmp_path), "root")
    assert result["bgg_id"] == 237182
    assert result["edition"] == "2018"
    assert result["pdf_url"] is None
    assert result["base_game_slug"] is None


def test_read_existing_game_extracts_pdf_url(tmp_path):
    from compiler.refresh_sections import _read_existing_game
    _write_index(tmp_path, "root", extra_frontmatter='pdf_url: "https://example.com/root.pdf"\n')
    result = _read_existing_game(str(tmp_path), "root")
    assert result["pdf_url"] == "https://example.com/root.pdf"


def test_read_existing_game_extracts_base_game_slug(tmp_path):
    from compiler.refresh_sections import _read_existing_game
    _write_index(tmp_path, "pandemic-in-the-lab-2014", extra_frontmatter="base_game_slug: pandemic-2008\n")
    result = _read_existing_game(str(tmp_path), "pandemic-in-the-lab-2014")
    assert result["base_game_slug"] == "pandemic-2008"


def test_read_existing_game_exits_when_slug_not_in_wiki(tmp_path):
    from compiler.refresh_sections import _read_existing_game
    with pytest.raises(SystemExit) as exc:
        _read_existing_game(str(tmp_path), "nonexistent-slug")
    assert exc.value.code == 1


# ── main() path tests ────────────────────────────────────────────────────────

def test_main_regenerates_only_requested_section(tmp_path):
    _write_index(tmp_path, "root")

    with (
        patch("compiler.refresh_sections.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", return_value=(TEACHING_ONLY, [])) as mock_compile,
        patch("compiler.refresh_sections.update_sections") as mock_update,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        main(slug="root", sections={"teaching"}, wiki_path=str(tmp_path))

    compile_kwargs = mock_compile.call_args.kwargs
    assert compile_kwargs["only_sections"] == {"teaching"}
    update_args = mock_update.call_args[0]
    assert update_args[1] == "root"
    assert update_args[2] == TEACHING_ONLY


def test_main_preserves_existing_slug_and_edition_not_recomputed(tmp_path):
    _write_index(tmp_path, "root")
    # fetch_game returns a DIFFERENT slug/no-edition — main() must not use it.
    fresh_bgg_data = {**GAME_DATA, "slug": "root-renamed-on-bgg"}
    captured = {}

    def capture_compile(game_data, *args, **kwargs):
        captured.update(game_data)
        return (TEACHING_ONLY, [])

    with (
        patch("compiler.refresh_sections.fetch_game", return_value=fresh_bgg_data),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", side_effect=capture_compile),
        patch("compiler.refresh_sections.update_sections"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        main(slug="root", sections={"teaching"}, wiki_path=str(tmp_path))

    assert captured["slug"] == "root"
    assert captured["edition"] == "2018"


def test_main_redownloads_pdf_when_frontmatter_has_pdf_url(tmp_path):
    _write_index(tmp_path, "root", extra_frontmatter='pdf_url: "https://example.com/root.pdf"\n')

    with (
        patch("compiler.refresh_sections.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.refresh_sections.fetch_pdf", return_value=b"%PDF") as mock_fetch_pdf,
        patch("compiler.refresh_sections.extract_text", return_value="Rulebook text") as mock_extract,
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", return_value=(TEACHING_ONLY, [])) as mock_compile,
        patch("compiler.refresh_sections.update_sections"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        main(slug="root", sections={"teaching"}, wiki_path=str(tmp_path))

    mock_fetch_pdf.assert_called_once_with("https://example.com/root.pdf")
    mock_extract.assert_called_once_with(b"%PDF")
    compile_args = mock_compile.call_args[0]
    assert compile_args[1] == "Rulebook text"  # rulebook_text
    assert compile_args[2] == b"%PDF"           # pdf_bytes


def test_main_llm_only_when_no_pdf_url_applies_warning(tmp_path):
    _write_index(tmp_path, "root")

    with (
        patch("compiler.refresh_sections.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", return_value=(TEACHING_ONLY, [])),
        patch("compiler.refresh_sections.update_sections") as mock_update,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        main(slug="root", sections={"teaching"}, wiki_path=str(tmp_path))

    update_kwargs = mock_update.call_args.kwargs
    assert "[!WARNING]" in update_kwargs["warning"]


def test_main_sets_expansion_fields_from_frontmatter(tmp_path):
    _write_index(tmp_path, "pandemic-2008")
    _write_index(tmp_path, "pandemic-in-the-lab-2014", extra_frontmatter="base_game_slug: pandemic-2008\n")
    captured = {}

    def capture_compile(game_data, *args, **kwargs):
        captured.update(game_data)
        return (TEACHING_ONLY, [])

    with (
        patch("compiler.refresh_sections.fetch_game", return_value={**GAME_DATA, "is_expansion": True}),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", side_effect=capture_compile),
        patch("compiler.refresh_sections.update_sections"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        main(slug="pandemic-in-the-lab-2014", sections={"teaching"}, wiki_path=str(tmp_path))

    assert captured["is_expansion"] is True
    assert captured["base_game_slug"] == "pandemic-2008"
    assert captured["base_game_name"] == "Root"  # name field written by _write_index helper


def test_main_exits_when_base_game_not_in_wiki(tmp_path):
    _write_index(tmp_path, "pandemic-in-the-lab-2014", extra_frontmatter="base_game_slug: pandemic-2008\n")
    # Note: "pandemic-2008" is intentionally never written to tmp_path/games/.

    with (
        patch("compiler.refresh_sections.fetch_game", return_value={**GAME_DATA, "is_expansion": True}),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        with pytest.raises(SystemExit) as exc:
            main(slug="pandemic-in-the-lab-2014", sections={"teaching"}, wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_exits_on_invalid_section_name(tmp_path):
    _write_index(tmp_path, "root")
    with patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}):
        from compiler.refresh_sections import main
        with pytest.raises(SystemExit) as exc:
            main(slug="root", sections={"not-a-real-section"}, wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_exits_when_all_requested_sections_fail(tmp_path):
    _write_index(tmp_path, "root")
    with (
        patch("compiler.refresh_sections.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", return_value=({}, ["teaching"])),
        patch("compiler.refresh_sections.update_sections") as mock_update,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        with pytest.raises(SystemExit) as exc:
            main(slug="root", sections={"teaching"}, wiki_path=str(tmp_path))
        assert exc.value.code == 1
    mock_update.assert_not_called()
