import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from compiler.bgg_fetcher import fetch_game, _to_slug
from compiler.pdf_fetcher import fetch_pdf
from compiler.pdf_parser import extract_text
from compiler.llm_provider import DeepSeekProvider, GeminiProvider
from compiler.llm_compiler import compile_game, generate_mechanic_description
from compiler.wiki_writer import write_game, mechanic_page_exists, sync_mechanic_pages


def _resolve_edition(game_data: dict, edition_override: str | None) -> str:
    if edition_override:
        return _to_slug(edition_override)
    year = game_data.get("yearpublished", 0)
    return str(year) if year else "unknown"


def find_base_game_in_wiki(wiki_path: str, bgg_id: int) -> dict | None:
    for index_file in Path(wiki_path).glob("games/*/index.md"):
        content = index_file.read_text()
        lines = content.splitlines()
        if not any(line.strip() == f"bgg_id: {bgg_id}" for line in lines):
            continue
        for line in lines:
            if line.startswith('name: "'):
                name = line.split('"')[1]
                return {"slug": index_file.parent.name, "name": name}
    return None


def main(
    bgg_id: int,
    pdf_url: str | None,
    status: str,
    wiki_path: str,
    edition: str | None = None,
    name: str | None = None,
    base_game_bgg_id: int | None = None,
) -> None:
    bgg_token = os.environ.get("GAMECACHE_BGG_TOKEN")
    deepseek_key = os.environ["DEEPSEEK_API_KEY"]
    gemini_key = os.environ["GEMINI_API_KEY"]

    provider = DeepSeekProvider(api_key=deepseek_key)
    gemini_provider = GeminiProvider(api_key=gemini_key)

    print(f"Fetching BGG data for game {bgg_id}...")
    game_data = fetch_game(bgg_id, token=bgg_token)

    if name:
        # Some BGG entries bundle several distinct maps/variants under one id
        # (e.g. Ticket to Ride's "Map Collection" expansions) — overriding the
        # name lets each map become its own wiki entry with its own slug,
        # instead of colliding on the single BGG-provided title.
        game_data["name"] = name
        game_data["slug"] = _to_slug(name)

    if base_game_bgg_id:
        # Overrides BGG's own "inbound expansion" link — useful when the
        # wiki's actual dependency differs from BGG's canonical one (e.g. an
        # expansion that BGG links to game A, but that the user wants filed
        # under a related game B instead).
        game_data["is_expansion"] = True
        game_data["base_game_id"] = base_game_bgg_id

    resolved_edition = _resolve_edition(game_data, edition)
    game_data["slug"] = f"{game_data['slug']}-{resolved_edition}"
    game_data["edition"] = resolved_edition
    print(f"Found: {game_data['name']} ({game_data['slug']})")

    if game_data.get("is_expansion") and game_data.get("base_game_id"):
        base = find_base_game_in_wiki(wiki_path, game_data["base_game_id"])
        if base is None:
            print(
                f"Error: base game (bgg_id={game_data['base_game_id']}) not found in wiki. "
                "Import the base game first.",
                file=sys.stderr,
            )
            sys.exit(1)
        game_data["base_game_slug"] = base["slug"]
        game_data["base_game_name"] = base["name"]
        print(f"Expansion of: {base['name']} ({base['slug']})")

    if pdf_url:
        print(f"Downloading PDF from {pdf_url}...")
        pdf_bytes = fetch_pdf(pdf_url)
        rulebook_text = extract_text(pdf_bytes)
        if not rulebook_text:
            print("Error: PDF extracted no text. Provide a searchable (non-scanned) PDF or use --edition without --pdf_url.", file=sys.stderr)
            sys.exit(1)
        print(f"Extracted {len(rulebook_text)} characters from PDF.")
        source = "pdf-manual"
        resolved_url: str | None = pdf_url
    else:
        if not edition:
            print("Error: --edition is required when --pdf_url is not provided.", file=sys.stderr)
            sys.exit(1)
        pdf_bytes = None
        rulebook_text = None
        source = "llm-only"
        resolved_url = None

    print("Compiling wiki sections...")
    sections, failures = compile_game(game_data, rulebook_text, pdf_bytes, provider, gemini_provider)

    if not sections:
        print(f"Error: all sections failed to generate: {failures}")
        sys.exit(1)

    new_mechanics = [
        m for m in game_data.get("mechanics", []) if not mechanic_page_exists(wiki_path, m)
    ]
    descriptions = {}
    if new_mechanics:
        print(f"Generating descriptions for {len(new_mechanics)} new mechanic(s)...")
    for mechanic in new_mechanics:
        try:
            descriptions[mechanic] = generate_mechanic_description(mechanic, provider)
        except Exception as e:
            print(f"Warning: failed to generate description for mechanic '{mechanic}': {e}")
    sync_mechanic_pages(wiki_path, game_data, descriptions)

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
    parser.add_argument("--name", type=str, default=None,
                        help="Override the BGG name (and derived slug) — for BGG entries that "
                        "bundle multiple distinct maps/variants under one id")
    parser.add_argument("--base_game_bgg_id", type=int, default=None,
                        help="Override which base game this is an expansion of (BGG numeric id) "
                        "— for when the wiki's intended dependency differs from BGG's own "
                        "'inbound expansion' link")
    parser.add_argument("--status", type=str, required=True,
                        choices=["owned", "wishlist", "borrowed", "friend", "played", "archived"])
    parser.add_argument("--wiki_path", type=str, required=True)
    args = parser.parse_args()

    main(
        bgg_id=args.bgg_id,
        pdf_url=args.pdf_url,
        edition=args.edition,
        name=args.name,
        base_game_bgg_id=args.base_game_bgg_id,
        status=args.status,
        wiki_path=args.wiki_path,
    )
