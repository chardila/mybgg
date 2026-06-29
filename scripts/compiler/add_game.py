import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from compiler.bgg_fetcher import fetch_game
from compiler.pdf_fetcher import fetch_pdf
from compiler.pdf_parser import extract_text
from compiler.llm_provider import DeepSeekProvider
from compiler.llm_compiler import compile_game
from compiler.wiki_writer import write_game


def main(bgg_id: int, pdf_url: str | None, status: str, wiki_path: str) -> None:
    bgg_token = os.environ.get("GAMECACHE_BGG_TOKEN") or None
    deepseek_key = os.environ["DEEPSEEK_API_KEY"]

    provider = DeepSeekProvider(api_key=deepseek_key)

    print(f"Fetching BGG data for game {bgg_id}...")
    game_data = fetch_game(bgg_id, token=bgg_token)
    print(f"Found: {game_data['name']} ({game_data['slug']})")

    rulebook_text = None
    source = "ai-generated"
    if pdf_url:
        print(f"Downloading PDF from {pdf_url}...")
        pdf_bytes = fetch_pdf(pdf_url)
        print("Extracting text from PDF...")
        rulebook_text = extract_text(pdf_bytes)
        source = "pdf"
        print(f"Extracted {len(rulebook_text)} characters from PDF.")
    else:
        print("No PDF provided — will use LLM knowledge.")

    print("Compiling wiki sections (6 LLM calls)...")
    sections, failures = compile_game(game_data, rulebook_text, provider)

    if not sections:
        print(f"Error: all sections failed to generate: {failures}")
        sys.exit(1)

    print(f"Writing wiki files to {wiki_path}/games/{game_data['slug']}/...")
    write_game(game_data, sections, wiki_path, status, source, pdf_url)

    print(f"Done! Wiki for '{game_data['name']}' committed to {wiki_path}.")
    if failures:
        print(f"Warning: {len(failures)} section(s) failed: {failures}")
        print(f"Re-run to retry failed sections: {failures}")
        sys.exit(len(failures))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import a board game into the wiki")
    parser.add_argument("--bgg_id", type=int, required=True,
                        help="BGG game ID (number in the BGG URL)")
    parser.add_argument("--pdf_url", type=str, default=None,
                        help="Direct URL to the rulebook PDF (optional)")
    parser.add_argument("--status", type=str, required=True,
                        choices=["owned", "wishlist", "borrowed", "friend", "played", "archived"])
    parser.add_argument("--wiki_path", type=str, required=True,
                        help="Path to the local mybgg-wiki repository")
    args = parser.parse_args()

    main(
        bgg_id=args.bgg_id,
        pdf_url=args.pdf_url if args.pdf_url else None,
        status=args.status,
        wiki_path=args.wiki_path,
    )
