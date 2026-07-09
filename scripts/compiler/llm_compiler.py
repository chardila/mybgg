import json
from compiler.llm_provider import LLMProvider

SYSTEM = (
    "You are a board game knowledge compiler. "
    "Write clear, accurate, well-structured Markdown pages about board games. "
    "Use [[Wiki Link]] syntax for cross-references to mechanics, concepts, and game-specific terms. "
    "Write in English. Be concise and precise. Do not include YAML frontmatter."
)

def _rulebook_block(rulebook_text: str | None, game_data: dict) -> str:
    if rulebook_text:
        return f"\nRulebook text (authoritative source):\n---\n{rulebook_text}\n---\n"
    edition = game_data.get("edition", "unknown")
    name = game_data["name"]
    return (
        f"\nNo rulebook provided. Generate from general knowledge for the "
        f"**{edition} edition** of \"{name}\". "
        "If rules or components differ between editions, note the uncertainty explicitly.\n"
    )


def _expansion_block(game_data: dict) -> str:
    if not game_data.get("is_expansion"):
        return ""
    base_name = game_data.get("base_game_name", "the base game")
    return (
        f"This is an expansion for **{base_name}**. "
        "Focus exclusively on what this expansion adds: new components, new rules, new mechanics. "
        f"Do not repeat or summarize the base game rules. "
        f"Assume the reader already knows how to play {base_name}.\n\n"
    )


def _prompts(game_data: dict, rulebook_text: str | None) -> dict[str, str]:
    name = game_data["name"]
    rb = _rulebook_block(rulebook_text, game_data)
    ex = _expansion_block(game_data)
    meta = (
        f"- Players: {game_data['players']}\n"
        f"- Playing time: {game_data['playing_time']} min\n"
        f"- Weight: {game_data['weight']}/5\n"
        f"- BGG Rank: {game_data['rank']}\n"
        f"- Edition: {game_data.get('edition', 'unknown')}\n"
        f"- Mechanics: {', '.join(game_data['mechanics'])}\n"
        f"- Categories: {', '.join(game_data['categories'])}\n"
        f"- Description: {game_data['description'][:500]}\n"
    )
    return {
        "index": (
            f"{ex}Write a Markdown overview page for the board game \"{name}\".\n\n"
            f"BGG Data:\n{meta}{rb}\n"
            "Include:\n"
            "1. A 2-3 paragraph summary of what the game is and why it is interesting\n"
            "2. A 'Key Info' section with the BGG metadata as a Markdown table\n"
            "3. Links to related mechanics using [[Mechanic Name]] syntax"
        ),
        "setup": (
            f"{ex}Write a Markdown setup guide for \"{name}\".\n{rb}\n"
            "Include:\n"
            "1. Complete components list\n"
            "2. Step-by-step setup instructions (numbered)\n"
            "3. Setup variations by player count (if any)\n"
            "Use [[term]] syntax for game-specific components."
        ),
        "rules": (
            f"{ex}Write a complete Markdown rules reference for \"{name}\".\n{rb}\n"
            "Include:\n"
            "1. Turn structure (in order)\n"
            "2. Core mechanics explained clearly\n"
            "3. Special rules and edge cases\n"
            "4. End-game conditions and scoring\n"
            "5. Player count differences (if any)\n"
            "Use [[term]] syntax for game-specific terms."
        ),
        "teaching": (
            f"{ex}Write a Markdown teaching guide for explaining \"{name}\" to new players.\n{rb}\n"
            "Include these sections:\n"
            "1. **5-minute explanation** — shortest useful introduction\n"
            "2. **Suggested teaching order** — what to explain first, second, third\n"
            "3. **First-round walkthrough** — narrate a typical first round\n"
            "4. **Rules to postpone** — what to defer until it comes up naturally\n"
            "5. **Common mistakes** — what new players get wrong most often\n"
            "6. **Frequently forgotten rules** — even experienced players miss these"
        ),
        "faq": (
            f"{ex}Write a Markdown FAQ for \"{name}\" addressing common rules questions.\n{rb}\n"
            "Format as Q&A pairs. Cover:\n"
            "1. Situations that come up frequently\n"
            "2. Rules interactions commonly misunderstood\n"
            "3. Edge cases from the rulebook\n"
            "Use [[term]] syntax for game-specific terms."
        ),
        "glossary": (
            f"{ex}Write a Markdown glossary for \"{name}\" covering all game-specific terms.\n{rb}\n"
            "Format each entry as:\n"
            "## Term Name\n\n"
            "English definition (1-2 sentences).\n\n"
            "**Español:** Spanish translation or description.\n\n"
            "Order entries alphabetically. Include all components, actions, and concepts."
        ),
    }


def compile_game(
    game_data: dict,
    rulebook_text: str | None,
    provider: LLMProvider,
) -> tuple[dict[str, str], list[str]]:
    prompts = _prompts(game_data, rulebook_text)
    sections: dict[str, str] = {}
    failures: list[str] = []

    for section_name, prompt in prompts.items():
        try:
            sections[section_name] = provider.generate(system=SYSTEM, prompt=prompt)
        except Exception as e:
            print(f"Warning: failed to generate '{section_name}': {e}")
            failures.append(section_name)

    return sections, failures


MAX_RULES_CHAPTERS = 8


def _strip_json_fences(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.endswith("```"):
            text = text[:-3]
    return text.strip()


def plan_rules_outline(rulebook_text: str, provider: LLMProvider) -> list[dict] | None:
    prompt = (
        "Given this rulebook text, identify the page ranges that contain CORE RULES "
        "content (turn structure, actions, combat, scoring, edge cases) — exclude "
        "setup/component lists, FAQ, and glossary-style content.\n"
        f"Divide into at most {MAX_RULES_CHAPTERS} logical chapters. Return strict JSON, "
        "no markdown fences, no commentary:\n"
        '[{"titulo": "...", "paginas": [start, end]}, ...]\n'
        "If you cannot confidently identify chapter boundaries, return an empty array.\n\n"
        f"Rulebook text:\n---\n{rulebook_text}\n---"
    )
    try:
        raw = provider.generate(system="You are a board game rules analyst.", prompt=prompt)
        chapters = json.loads(_strip_json_fences(raw))
    except Exception:
        return None

    if not isinstance(chapters, list) or len(chapters) == 0:
        return None

    valid = []
    for chapter in chapters:
        if not isinstance(chapter, dict):
            continue
        pages = chapter.get("paginas")
        if not (isinstance(pages, list) and len(pages) == 2):
            continue
        try:
            start, end = int(pages[0]), int(pages[1])
        except (TypeError, ValueError):
            continue
        if start < 1 or end < start:
            continue
        valid.append({"titulo": chapter.get("titulo") or "Rules", "paginas": [start, end]})

    if not valid:
        return None

    return _merge_chapters_to_cap(valid, MAX_RULES_CHAPTERS)


def _merge_chapters_to_cap(chapters: list[dict], cap: int) -> list[dict]:
    chapters = list(chapters)
    while len(chapters) > cap:
        best_i = min(
            range(len(chapters) - 1),
            key=lambda i: chapters[i + 1]["paginas"][1] - chapters[i]["paginas"][0],
        )
        a, b = chapters[best_i], chapters[best_i + 1]
        merged = {
            "titulo": f"{a['titulo']} / {b['titulo']}",
            "paginas": [a["paginas"][0], b["paginas"][1]],
        }
        chapters[best_i : best_i + 2] = [merged]
    return chapters
