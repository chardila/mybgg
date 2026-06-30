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
