from unittest.mock import patch
from pathlib import Path
import pytest
from compiler.wiki_writer import write_game, _build_frontmatter


GAME_DATA = {
    "id": 237182,
    "name": "Root",
    "slug": "root",
    "mechanics": ["Area Control", "Hand Management"],
    "players": "2-4",
    "weight": "3.72",
    "rank": "21",
}

SECTIONS = {
    "index": "## Overview\n\nRoot is a game about...",
    "setup": "## Setup\n\nPlace the board...",
    "rules": "## Rules\n\nEach turn...",
    "teaching": "## Teaching\n\nStart by...",
    "faq": "## FAQ\n\nQ: Can I...",
    "glossary": "## Clearings\n\nA territory type.",
}


def test_write_game_creates_directory(tmp_path):
    with patch("compiler.wiki_writer._git_commit_and_push"):
        write_game(GAME_DATA, SECTIONS, str(tmp_path), "owned", "pdf",
                   "https://example.com/root.pdf")

    assert (tmp_path / "games" / "root").is_dir()


def test_write_game_creates_all_section_files(tmp_path):
    with patch("compiler.wiki_writer._git_commit_and_push"):
        write_game(GAME_DATA, SECTIONS, str(tmp_path), "owned", "pdf")

    game_dir = tmp_path / "games" / "root"
    for section in ["index", "setup", "rules", "teaching", "faq", "glossary"]:
        assert (game_dir / f"{section}.md").exists()


def test_index_md_has_frontmatter(tmp_path):
    with patch("compiler.wiki_writer._git_commit_and_push"):
        write_game(GAME_DATA, SECTIONS, str(tmp_path), "owned", "pdf")

    content = (tmp_path / "games" / "root" / "index.md").read_text()
    assert content.startswith("---\n")
    assert "bgg_id: 237182" in content
    assert "status: owned" in content
    assert "source: pdf" in content


def test_other_sections_have_no_frontmatter(tmp_path):
    with patch("compiler.wiki_writer._git_commit_and_push"):
        write_game(GAME_DATA, SECTIONS, str(tmp_path), "owned", "ai-generated")

    setup_content = (tmp_path / "games" / "root" / "setup.md").read_text()
    assert not setup_content.startswith("---")
    assert setup_content == SECTIONS["setup"]


def test_build_frontmatter_includes_pdf_url():
    from datetime import date
    fm = _build_frontmatter(GAME_DATA, "owned", "pdf", "https://example.com/root.pdf")
    assert 'pdf_url: "https://example.com/root.pdf"' in fm


def test_build_frontmatter_omits_pdf_url_when_none():
    fm = _build_frontmatter(GAME_DATA, "ai-generated", "ai-generated", None)
    assert "pdf_url" not in fm


GAME_DATA_WITH_EDITION = {
    "id": 237182,
    "name": "Root",
    "slug": "root-2018",
    "edition": "2018",
    "yearpublished": 2018,
    "mechanics": ["Area Control"],
    "players": "2-4",
    "weight": "3.72",
    "rank": "21",
}


def test_build_frontmatter_includes_edition():
    fm = _build_frontmatter(GAME_DATA_WITH_EDITION, "owned", "pdf-manual", None)
    assert 'edition: "2018"' in fm
    assert "yearpublished: 2018" in fm


def test_build_frontmatter_edition_defaults_when_missing():
    fm = _build_frontmatter(GAME_DATA, "owned", "pdf-manual", None)
    assert 'edition: "unknown"' in fm
    assert "yearpublished: 0" in fm


GAME_DATA_LLM = {
    "id": 237182,
    "name": "Root",
    "slug": "root-kickstarter",
    "edition": "kickstarter",
    "yearpublished": 2019,
    "mechanics": ["Area Control"],
    "players": "2-4",
    "weight": "3.72",
    "rank": "21",
}


def test_llm_only_warning_appears_in_all_sections(tmp_path):
    with patch("compiler.wiki_writer._git_commit_and_push"):
        write_game(GAME_DATA_LLM, SECTIONS, str(tmp_path), "owned", "llm-only")

    game_dir = tmp_path / "games" / "root-kickstarter"
    for section in ["index", "setup", "rules", "teaching", "faq", "glossary"]:
        content = (game_dir / f"{section}.md").read_text()
        assert "[!WARNING]" in content
        assert "kickstarter" in content
        assert "LLM" in content


def test_pdf_manual_source_has_no_warning(tmp_path):
    with patch("compiler.wiki_writer._git_commit_and_push"):
        write_game(GAME_DATA_WITH_EDITION, SECTIONS, str(tmp_path), "owned", "pdf-manual",
                   "https://example.com/root.pdf")

    game_dir = tmp_path / "games" / "root-2018"
    for section in ["setup", "rules", "teaching", "faq", "glossary"]:
        content = (game_dir / f"{section}.md").read_text()
        assert "[!WARNING]" not in content


GAME_DATA_EXPANSION = {
    "id": 161936,
    "name": "Pandemic: In the Lab",
    "slug": "pandemic-in-the-lab-2014",
    "edition": "2014",
    "yearpublished": 2014,
    "mechanics": ["Cooperative Game"],
    "players": "2-4",
    "weight": "2.5",
    "rank": "Not Ranked",
    "is_expansion": True,
    "base_game_id": 30549,
    "base_game_slug": "pandemic-2008",
    "base_game_name": "Pandemic",
}


def test_expansion_frontmatter_includes_base_game_fields():
    fm = _build_frontmatter(GAME_DATA_EXPANSION, "owned", "pdf-manual", None)
    assert "base_game_bgg_id: 30549" in fm
    assert 'base_game_slug: pandemic-2008' in fm


def test_base_game_frontmatter_has_no_expansion_fields():
    fm = _build_frontmatter(GAME_DATA_WITH_EDITION, "owned", "pdf-manual", None)
    assert "base_game_bgg_id" not in fm
    assert "base_game_slug" not in fm


def test_update_base_game_creates_expansions_section(tmp_path):
    from compiler.wiki_writer import _update_base_game_expansions
    base_dir = tmp_path / "games" / "pandemic-2008"
    base_dir.mkdir(parents=True)
    (base_dir / "index.md").write_text("---\nbgg_id: 30549\n---\n\n# Pandemic\n\nGreat game.")

    _update_base_game_expansions(str(tmp_path), "pandemic-2008", "pandemic-in-the-lab-2014", "Pandemic: In the Lab")

    content = (base_dir / "index.md").read_text()
    assert "## Expansions" in content
    assert "[[pandemic-in-the-lab-2014]]" in content
    assert "Pandemic: In the Lab" in content


def test_update_base_game_appends_to_existing_expansions_section(tmp_path):
    from compiler.wiki_writer import _update_base_game_expansions
    base_dir = tmp_path / "games" / "pandemic-2008"
    base_dir.mkdir(parents=True)
    (base_dir / "index.md").write_text(
        "---\nbgg_id: 30549\n---\n\n# Pandemic\n\n## Expansions\n\n- [[pandemic-on-the-brink-2009]] — On the Brink\n"
    )

    _update_base_game_expansions(str(tmp_path), "pandemic-2008", "pandemic-in-the-lab-2014", "Pandemic: In the Lab")

    content = (base_dir / "index.md").read_text()
    assert "[[pandemic-on-the-brink-2009]]" in content
    assert "[[pandemic-in-the-lab-2014]]" in content
    assert content.count("## Expansions") == 1


def test_update_base_game_does_not_duplicate_entry(tmp_path):
    from compiler.wiki_writer import _update_base_game_expansions
    base_dir = tmp_path / "games" / "pandemic-2008"
    base_dir.mkdir(parents=True)
    (base_dir / "index.md").write_text(
        "---\nbgg_id: 30549\n---\n\n## Expansions\n\n- [[pandemic-in-the-lab-2014]] — Pandemic: In the Lab\n"
    )

    _update_base_game_expansions(str(tmp_path), "pandemic-2008", "pandemic-in-the-lab-2014", "Pandemic: In the Lab")

    content = (base_dir / "index.md").read_text()
    assert content.count("pandemic-in-the-lab-2014") == 1


def test_write_game_expansion_calls_update_base_game(tmp_path):
    with (
        patch("compiler.wiki_writer._git_commit_and_push"),
        patch("compiler.wiki_writer._update_base_game_expansions") as mock_update,
    ):
        write_game(GAME_DATA_EXPANSION, SECTIONS, str(tmp_path), "owned", "pdf-manual")

    mock_update.assert_called_once_with(
        str(tmp_path), "pandemic-2008", "pandemic-in-the-lab-2014", "Pandemic: In the Lab"
    )


def test_write_game_base_game_does_not_call_update(tmp_path):
    with (
        patch("compiler.wiki_writer._git_commit_and_push"),
        patch("compiler.wiki_writer._update_base_game_expansions") as mock_update,
    ):
        write_game(GAME_DATA_WITH_EDITION, SECTIONS, str(tmp_path), "owned", "pdf-manual")

    mock_update.assert_not_called()


def test_write_game_preserves_existing_expansions_section_on_reimport(tmp_path):
    game_dir = tmp_path / "games" / "root"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        "---\nbgg_id: 237182\n---\n\n# Root\n\n## Expansions\n\n"
        "- [[root-riverfolk-expansion]] — The Riverfolk Expansion\n"
    )

    with patch("compiler.wiki_writer._git_commit_and_push"):
        write_game(GAME_DATA, SECTIONS, str(tmp_path), "owned", "pdf")

    content = (game_dir / "index.md").read_text()
    assert "## Expansions" in content
    assert "[[root-riverfolk-expansion]]" in content
    assert content.count("## Expansions") == 1


def test_build_frontmatter_does_not_crash_when_expansion_has_no_inbound_link():
    game_data = {
        "id": 161936, "name": "Pandemic: In the Lab",
        "slug": "pandemic-in-the-lab-2014", "edition": "2014",
        "yearpublished": 2014, "mechanics": [],
        "players": "2-4", "weight": "2.5", "rank": "Not Ranked",
        "is_expansion": True, "base_game_id": None,
        # base_game_slug intentionally absent
    }
    fm = _build_frontmatter(game_data, "owned", "pdf-manual", None)
    assert "base_game_bgg_id" not in fm
    assert "base_game_slug" not in fm


def test_mechanic_page_exists_false_when_missing(tmp_path):
    from compiler.wiki_writer import mechanic_page_exists
    assert mechanic_page_exists(str(tmp_path), "Area Control") is False


def test_mechanic_page_exists_true_when_present(tmp_path):
    from compiler.wiki_writer import mechanic_page_exists
    mech_dir = tmp_path / "mechanics"
    mech_dir.mkdir()
    (mech_dir / "Area Control.md").write_text("# Area Control\n")
    assert mechanic_page_exists(str(tmp_path), "Area Control") is True


def test_sync_mechanic_pages_creates_new_page(tmp_path):
    from compiler.wiki_writer import sync_mechanic_pages
    game_data = {"slug": "root-2018", "name": "Root", "mechanics": ["Area Control"]}

    sync_mechanic_pages(str(tmp_path), game_data, {"Area Control": "A mechanic about map control."})

    content = (tmp_path / "mechanics" / "Area Control.md").read_text()
    assert content.startswith("# Area Control")
    assert "A mechanic about map control." in content
    assert "[[root-2018]] — Root" in content


def test_sync_mechanic_pages_appends_backlink_to_existing_page(tmp_path):
    from compiler.wiki_writer import sync_mechanic_pages
    mech_dir = tmp_path / "mechanics"
    mech_dir.mkdir()
    (mech_dir / "Area Control.md").write_text(
        "# Area Control\n\nDescription.\n\n## Juegos en tu catálogo que la usan:\n* [[scythe-2016]] — Scythe\n"
    )
    game_data = {"slug": "root-2018", "name": "Root", "mechanics": ["Area Control"]}

    sync_mechanic_pages(str(tmp_path), game_data, {})

    content = (mech_dir / "Area Control.md").read_text()
    assert "[[scythe-2016]] — Scythe" in content
    assert "[[root-2018]] — Root" in content


def test_sync_mechanic_pages_does_not_duplicate_backlink(tmp_path):
    from compiler.wiki_writer import sync_mechanic_pages
    mech_dir = tmp_path / "mechanics"
    mech_dir.mkdir()
    (mech_dir / "Area Control.md").write_text(
        "# Area Control\n\nDescription.\n\n## Juegos en tu catálogo que la usan:\n* [[root-2018]] — Root\n"
    )
    game_data = {"slug": "root-2018", "name": "Root", "mechanics": ["Area Control"]}

    sync_mechanic_pages(str(tmp_path), game_data, {})

    content = (mech_dir / "Area Control.md").read_text()
    assert content.count("[[root-2018]]") == 1


def test_sync_mechanic_pages_handles_multiple_mechanics(tmp_path):
    from compiler.wiki_writer import sync_mechanic_pages
    game_data = {"slug": "root-2018", "name": "Root", "mechanics": ["Area Control", "Hand Management"]}

    sync_mechanic_pages(
        str(tmp_path), game_data,
        {"Area Control": "Desc A.", "Hand Management": "Desc B."},
    )

    assert (tmp_path / "mechanics" / "Area Control.md").exists()
    assert (tmp_path / "mechanics" / "Hand Management.md").exists()


def test_sync_mechanic_pages_skips_when_no_description_available(tmp_path):
    from compiler.wiki_writer import sync_mechanic_pages
    game_data = {"slug": "root-2018", "name": "Root", "mechanics": ["Area Control"]}

    sync_mechanic_pages(str(tmp_path), game_data, {})  # no description generated for it

    assert not (tmp_path / "mechanics" / "Area Control.md").exists()


def test_sync_mechanic_pages_sanitizes_slash_in_filename(tmp_path):
    from compiler.wiki_writer import sync_mechanic_pages
    game_data = {"slug": "camel-up-2018", "name": "Camel Up", "mechanics": ["Roll / Spin and Move"]}

    sync_mechanic_pages(str(tmp_path), game_data, {"Roll / Spin and Move": "Players roll dice or spin to move."})

    mech_dir = tmp_path / "mechanics"
    assert (mech_dir / "Roll - Spin and Move.md").exists()
    content = (mech_dir / "Roll - Spin and Move.md").read_text()
    assert content.startswith("# Roll / Spin and Move")  # display name preserved as original


def test_mechanic_page_exists_checks_sanitized_filename(tmp_path):
    from compiler.wiki_writer import mechanic_page_exists
    mech_dir = tmp_path / "mechanics"
    mech_dir.mkdir()
    (mech_dir / "Roll - Spin and Move.md").write_text("# Roll / Spin and Move\n")
    assert mechanic_page_exists(str(tmp_path), "Roll / Spin and Move") is True


def test_git_commit_and_push_adds_mechanics_dir_when_present(tmp_path):
    from compiler.wiki_writer import _git_commit_and_push
    (tmp_path / "games" / "root").mkdir(parents=True)
    (tmp_path / "mechanics").mkdir()

    with patch("compiler.wiki_writer._git") as mock_git:
        _git_commit_and_push(str(tmp_path), "root", "Root")

    added_paths = [c.args[2] for c in mock_git.call_args_list if c.args[1] == "add"]
    assert "mechanics/" in added_paths


def test_git_commit_and_push_skips_mechanics_dir_when_absent(tmp_path):
    from compiler.wiki_writer import _git_commit_and_push
    (tmp_path / "games" / "root").mkdir(parents=True)

    with patch("compiler.wiki_writer._git") as mock_git:
        _git_commit_and_push(str(tmp_path), "root", "Root")

    added_paths = [c.args[2] for c in mock_git.call_args_list if c.args[1] == "add"]
    assert "mechanics/" not in added_paths
