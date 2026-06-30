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


def _prompts(game_data: dict, rulebook_text: str | None) -> dict[str, str]:
    name = game_data["name"]
    rb = _rulebook_block(rulebook_text, game_data)
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
            f"Write a Markdown overview page for the board game \"{name}\".\n\n"
            f"BGG Data:\n{meta}{rb}\n"
            "Include:\n"
            "1. A 2-3 paragraph summary of what the game is and why it is interesting\n"
            "2. A 'Key Info' section with the BGG metadata as a Markdown table\n"
            "3. Links to related mechanics using [[Mechanic Name]] syntax"
        ),
        "setup": (
            f"Write a Markdown setup guide for \"{name}\".\n{rb}\n"
            "Include:\n"
            "1. Complete components list\n"
            "2. Step-by-step setup instructions (numbered)\n"
            "3. Setup variations by player count (if any)\n"
            "Use [[term]] syntax for game-specific components."
        ),
        "rules": (
            f"Write a complete Markdown rules reference for \"{name}\".\n{rb}\n"
            "Include:\n"
            "1. Turn structure (in order)\n"
            "2. Core mechanics explained clearly\n"
            "3. Special rules and edge cases\n"
            "4. End-game conditions and scoring\n"
            "5. Player count differences (if any)\n"
            "Use [[term]] syntax for game-specific terms."
        ),
        "teaching": (
            f"Write a Markdown teaching guide for explaining \"{name}\" to new players.\n{rb}\n"
            "Include these sections:\n"
            "1. **5-minute explanation** — shortest useful introduction\n"
            "2. **Suggested teaching order** — what to explain first, second, third\n"
            "3. **First-round walkthrough** — narrate a typical first round\n"
            "4. **Rules to postpone** — what to defer until it comes up naturally\n"
            "5. **Common mistakes** — what new players get wrong most often\n"
            "6. **Frequently forgotten rules** — even experienced players miss these"
        ),
        "faq": (
            f"Write a Markdown FAQ for \"{name}\" addressing common rules questions.\n{rb}\n"
            "Format as Q&A pairs. Cover:\n"
            "1. Situations that come up frequently\n"
            "2. Rules interactions commonly misunderstood\n"
            "3. Edge cases from the rulebook\n"
            "Use [[term]] syntax for game-specific terms."
        ),
        "glossary": (
            f"Write a Markdown glossary for \"{name}\" covering all game-specific terms.\n{rb}\n"
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
