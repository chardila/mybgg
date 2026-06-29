import re
from gamecache.bgg_client import BGGClient


def fetch_game(bgg_id: int, token: str | None = None) -> dict:
    client = BGGClient(token=token)
    games = client.game_list([bgg_id])
    if not games:
        raise ValueError(f"Game {bgg_id} not found on BGG")
    raw = games[0]
    min_p = str(raw.get("min_players", "1"))
    max_p = str(raw.get("max_players", "1"))
    players = f"{min_p}-{max_p}" if min_p != max_p else min_p
    return {
        "id": raw["id"],
        "name": raw["name"],
        "slug": _to_slug(raw["name"]),
        "description": raw.get("description", ""),
        "mechanics": raw.get("mechanics", []),
        "categories": raw.get("categories", []),
        "players": players,
        "min_players": int(min_p),
        "max_players": int(max_p),
        "weight": str(raw.get("weight", "")),
        "rank": str(raw.get("rank", "")),
        "playing_time": str(raw.get("playing_time", "")),
    }


def _to_slug(name: str) -> str:
    slug = name.lower()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_]+", "-", slug)
    return slug.strip("-")
