import argparse
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from compiler.bgg_fetcher import fetch_game
from compiler.pdf_fetcher import fetch_pdf
from compiler.pdf_parser import extract_text
from compiler.llm_provider import DeepSeekProvider, GeminiProvider
from compiler.llm_compiler import compile_game, SECTION_ORDER
from compiler.wiki_writer import update_sections, _llm_only_warning

VALID_SECTIONS = set(SECTION_ORDER)


def _frontmatter_field(content: str, key: str) -> str | None:
    match = re.search(rf'^{key}:\s*"?([^"\n]+)"?', content, re.MULTILINE)
    return match.group(1).strip() if match else None


def _read_existing_game(wiki_path: str, slug: str) -> dict:
    index_path = Path(wiki_path) / "games" / slug / "index.md"
    if not index_path.exists():
        print(f"Error: no existing wiki entry for slug '{slug}' at {index_path}", file=sys.stderr)
        sys.exit(1)
    content = index_path.read_text()
    bgg_id = _frontmatter_field(content, "bgg_id")
    if bgg_id is None:
        print(f"Error: {index_path} has no bgg_id in frontmatter", file=sys.stderr)
        sys.exit(1)
    return {
        "bgg_id": int(bgg_id),
        "edition": _frontmatter_field(content, "edition") or "unknown",
        "pdf_url": _frontmatter_field(content, "pdf_url"),
        "base_game_slug": _frontmatter_field(content, "base_game_slug"),
    }


def _base_game_name(wiki_path: str, base_game_slug: str) -> str:
    index_path = Path(wiki_path) / "games" / base_game_slug / "index.md"
    if not index_path.exists():
        print(f"Error: base game '{base_game_slug}' not found in wiki.", file=sys.stderr)
        sys.exit(1)
    name = _frontmatter_field(index_path.read_text(), "name")
    if name is None:
        print(f"Error: {index_path} has no name in frontmatter", file=sys.stderr)
        sys.exit(1)
    return name


def main(slug: str, sections: set[str], wiki_path: str) -> None:
    invalid = sections - VALID_SECTIONS
    if invalid:
        print(
            f"Error: invalid section(s) {sorted(invalid)}. Valid: {sorted(VALID_SECTIONS)}",
            file=sys.stderr,
        )
        sys.exit(1)

    bgg_token = os.environ.get("GAMECACHE_BGG_TOKEN")
    deepseek_provider = DeepSeekProvider(api_key=os.environ["DEEPSEEK_API_KEY"])
    gemini_provider = GeminiProvider(api_key=os.environ["GEMINI_API_KEY"])

    existing = _read_existing_game(wiki_path, slug)

    print(f"Fetching fresh BGG data for bgg_id {existing['bgg_id']}...")
    game_data = fetch_game(existing["bgg_id"], token=bgg_token)
    game_data["slug"] = slug
    game_data["edition"] = existing["edition"]

    if existing["base_game_slug"]:
        game_data["is_expansion"] = True
        game_data["base_game_slug"] = existing["base_game_slug"]
        game_data["base_game_name"] = _base_game_name(wiki_path, existing["base_game_slug"])

    pdf_url = existing["pdf_url"]
    if pdf_url:
        print(f"Downloading PDF from {pdf_url}...")
        pdf_bytes = fetch_pdf(pdf_url)
        rulebook_text = extract_text(pdf_bytes)
        if not rulebook_text:
            print("Error: PDF extracted no text.", file=sys.stderr)
            sys.exit(1)
        print(f"Extracted {len(rulebook_text)} characters from PDF.")
    else:
        pdf_bytes = None
        rulebook_text = None

    print(f"Regenerating section(s) {sorted(sections)} for '{game_data['name']}' ({slug})...")
    generated, failures = compile_game(
        game_data, rulebook_text, pdf_bytes,
        deepseek_provider, gemini_provider,
        only_sections=sections,
    )

    if not generated:
        print(f"Error: all requested section(s) failed to generate: {failures}", file=sys.stderr)
        sys.exit(1)

    warning = _llm_only_warning(game_data["edition"]) if not rulebook_text else ""
    update_sections(wiki_path, slug, generated, game_data["name"], warning=warning)

    print(f"Done! Refreshed {sorted(generated.keys())} for '{game_data['name']}'.")
    if failures:
        print(f"Warning: {len(failures)} section(s) failed: {failures}")
        sys.exit(len(failures))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Regenerate specific wiki sections for an already-imported game"
    )
    parser.add_argument("--slug", type=str, required=True)
    parser.add_argument(
        "--sections", type=str, required=True,
        help="Comma-separated section names, e.g. 'teaching' or 'teaching,faq'",
    )
    parser.add_argument("--wiki_path", type=str, required=True)
    args = parser.parse_args()

    sections = {s.strip() for s in args.sections.split(",") if s.strip()}
    main(slug=args.slug, sections=sections, wiki_path=args.wiki_path)
