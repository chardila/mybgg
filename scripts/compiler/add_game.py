import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from compiler.bgg_fetcher import fetch_game, _to_slug
from compiler.pdf_fetcher import fetch_pdf
from compiler.pdf_parser import extract_text
from compiler.llm_provider import DeepSeekProvider
from compiler.llm_compiler import compile_game
from compiler.wiki_writer import write_game


def _resolve_edition(game_data: dict, edition_override: str | None) -> str:
    if edition_override:
        return _to_slug(edition_override)
    year = game_data.get("yearpublished", 0)
    return str(year) if year else "unknown"


def main(
    bgg_id: int,
    pdf_url: str | None,
    status: str,
    wiki_path: str,
    edition: str | None = None,
) -> None:
    bgg_token = os.environ.get("GAMECACHE_BGG_TOKEN") or None
    deepseek_key = os.environ["DEEPSEEK_API_KEY"]

    provider = DeepSeekProvider(api_key=deepseek_key)

    print(f"Fetching BGG data for game {bgg_id}...")
    game_data = fetch_game(bgg_id, token=bgg_token)

    resolved_edition = _resolve_edition(game_data, edition)
    game_data["slug"] = f"{game_data['slug']}-{resolved_edition}"
    game_data["edition"] = resolved_edition
    print(f"Found: {game_data['name']} ({game_data['slug']})")

    if pdf_url:
        print(f"Downloading PDF from {pdf_url}...")
        pdf_bytes = fetch_pdf(pdf_url)
        rulebook_text = extract_text(pdf_bytes)
        print(f"Extracted {len(rulebook_text)} characters from PDF.")
        source = "pdf-manual"
        resolved_url: str | None = pdf_url
    else:
        if not edition:
            print("Error: --edition is required when --pdf_url is not provided.")
            sys.exit(1)
        rulebook_text = None
        source = "llm-only"
        resolved_url = None

    print("Compiling wiki sections (6 LLM calls)...")
    sections, failures = compile_game(game_data, rulebook_text, provider)

    if not sections:
        print(f"Error: all sections failed to generate: {failures}")
        sys.exit(1)

    print(f"Writing wiki files to {wiki_path}/games/{game_data['slug']}/...")
    write_game(game_data, sections, wiki_path, status, source, resolved_url)

    print(f"Done! Wiki for '{game_data['name']}' committed to {wiki_path}.")
    if failures:
        print(f"Warning: {len(failures)} section(s) failed: {failures}")
        sys.exit(len(failures))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import a board game into the wiki")
    parser.add_argument("--bgg_id", type=int, required=True)
    parser.add_argument("--pdf_url", type=str, default=None)
    parser.add_argument("--edition", type=str, default=None,
                        help="Edition label (required when --pdf_url is not provided)")
    parser.add_argument("--status", type=str, required=True,
                        choices=["owned", "wishlist", "borrowed", "friend", "played", "archived"])
    parser.add_argument("--wiki_path", type=str, required=True)
    args = parser.parse_args()

    main(
        bgg_id=args.bgg_id,
        pdf_url=args.pdf_url if args.pdf_url else None,
        edition=args.edition if args.edition else None,
        status=args.status,
        wiki_path=args.wiki_path,
    )
