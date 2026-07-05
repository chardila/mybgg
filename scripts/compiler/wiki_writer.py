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

    warning = _llm_only_warning(game_data.get("edition", "unknown")) if source == "llm-only" else ""

    frontmatter = _build_frontmatter(game_data, status, source, pdf_url)
    index_content = sections.get("index", "")
    new_index = f"{frontmatter}\n{warning}{index_content}"

    index_path = game_dir / "index.md"
    if index_path.exists():
        existing_expansions = _extract_expansions_section(index_path.read_text())
        if existing_expansions and "## Expansions" not in new_index:
            new_index = new_index.rstrip() + f"\n\n{existing_expansions}\n"
    index_path.write_text(new_index)

    for section in ["setup", "rules", "teaching", "faq", "glossary"]:
        if section in sections:
            (game_dir / f"{section}.md").write_text(f"{warning}{sections[section]}")

    if game_data.get("is_expansion") and game_data.get("base_game_slug"):
        _update_base_game_expansions(
            wiki_path,
            game_data["base_game_slug"],
            game_data["slug"],
            game_data["name"],
        )

    _git_commit_and_push(
        wiki_path,
        game_data["slug"],
        game_data["name"],
        game_data.get("base_game_slug"),
    )


def _llm_only_warning(edition: str) -> str:
    return (
        "> [!WARNING]\n"
        "> Contenido generado desde conocimiento general del LLM sin rulebook verificado.\n"
        f"> Edición de referencia: **{edition}**. Puede diferir de otras ediciones.\n\n"
    )


def _extract_expansions_section(content: str) -> str | None:
    marker = "## Expansions"
    idx = content.find(marker)
    if idx == -1:
        return None
    return content[idx:].rstrip()


def _update_base_game_expansions(
    wiki_path: str,
    base_game_slug: str,
    expansion_slug: str,
    expansion_name: str,
) -> None:
    index_path = Path(wiki_path) / "games" / base_game_slug / "index.md"
    if not index_path.exists():
        return
    content = index_path.read_text()
    new_entry = f"- [[{expansion_slug}]] — {expansion_name}"
    if new_entry in content:
        return
    if "## Expansions" in content:
        content = content.rstrip() + f"\n{new_entry}\n"
    else:
        content = content.rstrip() + f"\n\n## Expansions\n\n{new_entry}\n"
    index_path.write_text(content)


def _build_frontmatter(
    game_data: dict,
    status: str,
    source: str,
    pdf_url: str | None,
) -> str:
    lines = [
        "---",
        f"bgg_id: {game_data['id']}",
        f'name: "{game_data["name"]}"',
        f"slug: {game_data['slug']}",
        f"status: {status}",
        f"source: {source}",
        f'edition: "{game_data.get("edition", "unknown")}"',
        f"yearpublished: {game_data.get('yearpublished', 0)}",
    ]
    if pdf_url is not None:
        lines.append(f'pdf_url: "{pdf_url}"')
    if game_data.get("is_expansion") and game_data.get("base_game_slug"):
        lines.append(f"base_game_bgg_id: {game_data['base_game_id']}")
        lines.append(f"base_game_slug: {game_data['base_game_slug']}")
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


def _git_commit_and_push(
    wiki_path: str,
    slug: str,
    name: str,
    base_game_slug: str | None = None,
) -> None:
    _git(wiki_path, "add", f"games/{slug}/")
    if base_game_slug:
        _git(wiki_path, "add", f"games/{base_game_slug}/index.md")
    result = subprocess.run(
        ["git", "-C", wiki_path, "diff", "--cached", "--quiet"],
        capture_output=True,
    )
    if result.returncode == 0:
        print(f"No changes to commit for {name} (content unchanged)")
        return
    _git(wiki_path, "commit", "-m", f"feat: add wiki for {name}")
    _git(wiki_path, "push")


def _git(wiki_path: str, *args: str) -> None:
    subprocess.run(["git", "-C", wiki_path, *args], check=True, capture_output=True)
