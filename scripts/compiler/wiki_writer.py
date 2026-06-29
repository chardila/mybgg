import subprocess
from datetime import date
from pathlib import Path


def write_game(
    game_data: dict,
    sections: dict[str, str],
    wiki_path: str,
    status: str,
    source: str,
    pdf_url: str | None = None,
) -> None:
    game_dir = Path(wiki_path) / "games" / game_data["slug"]
    game_dir.mkdir(parents=True, exist_ok=True)

    frontmatter = _build_frontmatter(game_data, status, source, pdf_url)
    index_content = sections.get("index", "")
    (game_dir / "index.md").write_text(f"{frontmatter}\n{index_content}")

    for section in ["setup", "rules", "teaching", "faq", "glossary"]:
        if section in sections:
            (game_dir / f"{section}.md").write_text(sections[section])

    _git_commit_and_push(wiki_path, game_data["slug"], game_data["name"])


def _build_frontmatter(
    game_data: dict,
    status: str,
    source: str,
    pdf_url: str | None,
) -> str:
    lines = [
        "---",
        f"bgg_id: {game_data['id']}",
        f"name: {game_data['name']}",
        f"slug: {game_data['slug']}",
        f"status: {status}",
        f"source: {source}",
    ]
    if pdf_url:
        lines.append(f"pdf_url: {pdf_url}")
    lines += [
        f"players: \"{game_data['players']}\"",
        f"weight: {game_data['weight']}",
        f"rank: {game_data['rank']}",
        "mechanics:",
    ]
    for mechanic in game_data.get("mechanics", []):
        lines.append(f"  - {mechanic}")
    lines += [
        f"imported: {date.today().isoformat()}",
        "---",
    ]
    return "\n".join(lines)


def _git_commit_and_push(wiki_path: str, slug: str, name: str) -> None:
    _git(wiki_path, "add", f"games/{slug}/")
    _git(wiki_path, "commit", "-m", f"feat: add wiki for {name}")
    _git(wiki_path, "push")


def _git(wiki_path: str, *args: str) -> None:
    subprocess.run(["git", "-C", wiki_path, *args], check=True, capture_output=True)
