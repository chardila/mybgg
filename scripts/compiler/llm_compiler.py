import json
from compiler.llm_provider import LLMProvider
from compiler.pdf_slicer import slice_pages, count_pages

SYSTEM = (
    "You are a board game knowledge compiler. "
    "Write clear, accurate, well-structured Markdown pages about board games. "
    "Use [[Wiki Link]] syntax for cross-references to mechanics, concepts, and game-specific terms. "
    "Write in English. Be concise and precise. Do not include YAML frontmatter."
)

MAX_RULES_CHAPTERS = 8

SECTION_ORDER = ["index", "setup", "rules", "teaching", "faq", "glossary"]


def _name_lock_note(game_data: dict) -> str:
    name = game_data["name"]
    description = (game_data.get("description") or "")[:500]
    hint = f"\nOfficial BGG description (for correct component naming):\n{description}\n" if description else ""
    return (
        f"Always refer to this game as \"{name}\" and use standard English names for its "
        "components/characters, even if the source material is a regional or translated "
        f"edition that uses a different title or names (e.g. a foreign-language rulebook). "
        f"Do not adopt an alternate title or transliterated name found in the source.\n{hint}"
    )


def _rulebook_block(rulebook_text: str | None, game_data: dict) -> str:
    if rulebook_text:
        return (
            f"\nRulebook text (authoritative source):\n---\n{rulebook_text}\n---\n"
            f"{_name_lock_note(game_data)}"
        )
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
            f"{ex}Write a teaching guide for \"{name}\", entirely in Spanish, addressed directly "
            "to a beginner learning the game for the first time (a child or an adult with no "
            "board-gaming experience) — as if you were sitting next to them explaining it. "
            "Use simple, warm, second-person language ('vos vas a...', 'ahora te toca...'). "
            "Never use board-gaming jargon (worker placement, engine building, etc.) without "
            "explaining it in plain words the first time it appears. Keep sentences short.\n"
            f"{rb}\n"
            "Include these sections, in this order:\n"
            "1. **Explicación de 5 minutos** — de qué se trata el juego, en el lenguaje más simple posible\n"
            "2. **Orden de enseñanza** — una lista numerada de temas a explicar, uno a la vez; cada ítem "
            "debe ser un párrafo corto y autocontenido, listo para leérselo o parafraseárselo al aprendiz "
            "directamente (no una instrucción meta como 'explicar que...', sino la explicación en sí)\n"
            "3. **Primera ronda paso a paso** — narra un primer turno típico en segunda persona, como si "
            "el aprendiz lo estuviera jugando en este momento\n"
            "4. **Reglas para más adelante** — reglas menores a mencionar solo si surgen naturalmente, no "
            "de entrada (esto es para que quien lidera la partida sepa qué callarse al principio)\n"
            "5. **Errores comunes de principiante** — en lenguaje simple, qué suelen hacer mal\n"
            "6. **Detalles que se olvidan** — reglas que hasta jugadores con experiencia pasan por alto"
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


def _rules_chapter_prompt(game_data: dict, chapter: dict) -> str:
    name = game_data["name"]
    ex = _expansion_block(game_data)
    return (
        f"{ex}Write the \"{chapter['titulo']}\" section of the Markdown rules reference "
        f"for \"{name}\".\n\n"
        f"{_name_lock_note(game_data)}\n"
        "The attached PDF pages are the authoritative source for this section, regardless "
        "of what language they are written in — write your output in English, translating "
        "as needed. Translate diagrams, component illustrations, and example-of-play images "
        "into structured Markdown text (numbered steps, descriptive lists, or a blockquote "
        "example) rather than describing that an image exists.\n\n"
        "Include:\n"
        "1. Turn structure and core mechanics covered in these pages\n"
        "2. Special rules and edge cases shown or stated here\n"
        "3. Any end-game or scoring rules covered in these pages\n"
        "Use [[term]] syntax for game-specific terms. Write only what these pages contain "
        "— do not repeat content that belongs to other chapters.\n"
        "Do not include a top-level page title (no '# Rules') — start directly with a "
        "'##' heading using this chapter's title."
    )


def _strip_json_fences(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.endswith("```"):
            text = text[:-3]
    return text.strip()


def plan_rules_outline(rulebook_text: str, num_pages: int, provider: LLMProvider) -> list[dict] | None:
    prompt = (
        f"Given this rulebook text, extracted from a PDF with exactly {num_pages} pages, "
        "identify the page ranges that contain CORE RULES "
        "content (turn structure, actions, combat, scoring, edge cases) — exclude "
        "setup/component lists, FAQ, and glossary-style content.\n"
        f"Page numbers in your answer MUST be within 1 and {num_pages} (inclusive) — "
        "this document has no pages outside that range.\n"
        f"Divide into at most {MAX_RULES_CHAPTERS} logical chapters. Return strict JSON, "
        "no markdown fences, no commentary:\n"
        '[{"titulo": "...", "paginas": [start, end]}, ...]\n'
        "The rulebook text may be in any language — regardless of its original language, "
        "\"titulo\" values MUST be in English, since they get used as section headings in "
        "an English-language wiki page.\n"
        "If you cannot confidently identify chapter boundaries, return an empty array.\n\n"
        f"Rulebook text:\n---\n{rulebook_text}\n---"
    )
    try:
        raw = provider.generate(
            system="You are a board game rules analyst. Always answer in English, "
            "even if the source material is in another language.",
            prompt=prompt,
        )
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
        if start < 1 or end < start or start > num_pages:
            continue
        end = min(end, num_pages)
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


def _compile_rules(
    game_data: dict,
    rulebook_text: str | None,
    pdf_bytes: bytes | None,
    fallback_prompt: str,
    deepseek_provider: LLMProvider,
    gemini_provider: LLMProvider,
    sections: dict[str, str],
    failures: list[str],
) -> None:
    if rulebook_text and pdf_bytes:
        try:
            num_pages = count_pages(pdf_bytes)
            outline = plan_rules_outline(rulebook_text, num_pages, gemini_provider)
        except Exception as e:
            print(f"Warning: failed to determine PDF page count for outline pass: {e}")
            outline = None
        if outline:
            chapter_texts = []
            for chapter in outline:
                try:
                    pdf_slice = slice_pages(pdf_bytes, [tuple(chapter["paginas"])])
                    if count_pages(pdf_slice) == 0:
                        raise ValueError("page range produced no pages")
                    chapter_prompt = _rules_chapter_prompt(game_data, chapter)
                    chapter_texts.append(
                        gemini_provider.generate_multimodal(SYSTEM, chapter_prompt, pdf_slice)
                    )
                except Exception as e:
                    print(f"Warning: failed to generate rules chapter '{chapter['titulo']}': {e}")
                    failures.append(f"rules (chapter: {chapter['titulo']})")
            if chapter_texts:
                sections["rules"] = "\n\n".join(chapter_texts)
                return
            print("Warning: all rules chapters failed, falling back to single-call text generation")

    try:
        sections["rules"] = deepseek_provider.generate(system=SYSTEM, prompt=fallback_prompt)
    except Exception as e:
        print(f"Warning: failed to generate 'rules': {e}")
        failures.append("rules")


def _compile_setup(
    pdf_bytes: bytes | None,
    prompt: str,
    deepseek_provider: LLMProvider,
    gemini_provider: LLMProvider,
    sections: dict[str, str],
    failures: list[str],
) -> None:
    if pdf_bytes:
        multimodal_prompt = prompt + (
            "\nIf component photos or setup diagrams are visible in the provided material, "
            "translate them into structured Markdown (numbered steps, descriptive lists) "
            "rather than describing that an image exists."
        )
        try:
            sections["setup"] = gemini_provider.generate_multimodal(SYSTEM, multimodal_prompt, pdf_bytes)
        except Exception as e:
            print(f"Warning: failed to generate 'setup': {e}")
            failures.append("setup")
        return

    try:
        sections["setup"] = deepseek_provider.generate(system=SYSTEM, prompt=prompt)
    except Exception as e:
        print(f"Warning: failed to generate 'setup': {e}")
        failures.append("setup")


def compile_game(
    game_data: dict,
    rulebook_text: str | None,
    pdf_bytes: bytes | None,
    deepseek_provider: LLMProvider,
    gemini_provider: LLMProvider,
    only_sections: set[str] | None = None,
) -> tuple[dict[str, str], list[str]]:
    prompts = _prompts(game_data, rulebook_text)
    sections: dict[str, str] = {}
    failures: list[str] = []

    for section_name in SECTION_ORDER:
        if only_sections is not None and section_name not in only_sections:
            continue
        if section_name == "rules":
            _compile_rules(
                game_data, rulebook_text, pdf_bytes, prompts["rules"],
                deepseek_provider, gemini_provider, sections, failures,
            )
        elif section_name == "setup":
            _compile_setup(
                pdf_bytes, prompts["setup"], deepseek_provider, gemini_provider,
                sections, failures,
            )
        else:
            try:
                sections[section_name] = deepseek_provider.generate(
                    system=SYSTEM, prompt=prompts[section_name]
                )
            except Exception as e:
                print(f"Warning: failed to generate '{section_name}': {e}")
                failures.append(section_name)

    return sections, failures


def generate_mechanic_description(name: str, provider: LLMProvider) -> str:
    prompt = (
        f"Describe the board game mechanic \"{name}\" in 1-2 sentences, for a personal "
        "Obsidian wiki. No heading, no frontmatter — plain prose only."
    )
    return provider.generate(system=SYSTEM, prompt=prompt)
