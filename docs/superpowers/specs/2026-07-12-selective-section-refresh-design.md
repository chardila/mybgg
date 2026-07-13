# Regeneración selectiva de secciones del wiki (`refresh_sections.py`)

**Fecha:** 2026-07-12
**Repo afectado:** `mybgg` (compilador Python en `scripts/compiler/`)

## 1. Objetivo

Después de implementar el modo de enseñanza guiada (`docs/superpowers/specs/2026-07-12-guided-teaching-mode-design.md`), el prompt que genera `teaching.md` cambió para producir contenido en español, dirigido al aprendiz. Ese cambio solo afecta a **juegos reimportados desde ahora** — los ~100 juegos ya importados conservan su `teaching.md` viejo (inglés, notas de instructor) hasta que se reimporten.

Hoy, "reimportar" (`add_game.py`) significa regenerar **las 6 secciones** (`index`, `setup`, `rules`, `teaching`, `faq`, `glossary`) sin importar cuál cambió — 6 llamadas LLM por juego, y riesgo de que `rules`/`faq`/`glossary`/`index` salgan distintos a lo que ya había, sin necesidad. Para refrescar solo `teaching.md` en varios juegos existentes, eso es un costo y un riesgo innecesarios.

Se agrega una forma de regenerar **solo las secciones pedidas** de un juego ya existente en el wiki, sin tocar las demás.

**Alcance:** herramienta de línea de comandos, genérica por sección (no hardcodeada a `teaching`) — mismo esfuerzo de implementación, más reutilizable a futuro (ej. corregir una sección con contenido erróneo sin reimportar todo). Sin cambios a la generación masiva (`bulk_import.py`) ni a los workflows de GitHub Actions — se invoca manualmente, puntual, juego por juego, cuando se vaya a enseñar.

## 2. Cambios en `llm_compiler.py`

`compile_game()` (línea 273) recibe un parámetro nuevo opcional, con default que preserva el comportamiento actual para todos los llamadores existentes:

```python
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
            _compile_rules(...)
        elif section_name == "setup":
            _compile_setup(...)
        else:
            try:
                sections[section_name] = deepseek_provider.generate(
                    system=SYSTEM, prompt=prompts[section_name]
                )
            except Exception as e:
                print(f"Warning: failed to generate '{section_name}': {e}")
                failures.append(section_name)

    return sections, failures
```

`add_game.py` y `bulk_import.py` no pasan `only_sections` → siguen generando las 6 secciones exactamente igual que hoy. Los tests existentes (`test_compile_game_returns_six_sections`, etc.) no cambian.

## 3. `wiki_writer.py`: escritura parcial

Función nueva, hermana de la lógica que ya existe dentro de `write_game()` (línea 30-32) pero sin tocar `index.md` ni requerir `status`/`source` completos, y con un commit acotado a los archivos tocados:

```python
def update_sections(
    wiki_path: str,
    slug: str,
    sections: dict[str, str],
    game_name: str,
    warning: str = "",
) -> None:
    game_dir = Path(wiki_path) / "games" / slug
    if not game_dir.exists():
        raise FileNotFoundError(f"No existing wiki entry for slug '{slug}' at {game_dir}")

    for section, content in sections.items():
        (game_dir / f"{section}.md").write_text(f"{warning}{content}")

    section_names = ", ".join(sorted(sections))
    _git(wiki_path, "add", *[str(game_dir / f"{s}.md") for s in sections])
    result = subprocess.run(
        ["git", "-C", wiki_path, "diff", "--cached", "--quiet"],
        capture_output=True,
    )
    if result.returncode == 0:
        print(f"No changes to commit for {game_name} ({section_names})")
        return
    _git(wiki_path, "commit", "-m", f"refresh: regenerate {section_names} for {game_name}")
    _git(wiki_path, "push")
```

`_git` y `_llm_only_warning` (línea 50-55) ya existen en el módulo y se reutilizan tal cual — `_llm_only_warning` ya es reusable como está (no depende de nada específico del flujo de `write_game`).

## 4. Script nuevo: `scripts/compiler/refresh_sections.py`

```
python -m compiler.refresh_sections --slug <slug> --sections teaching --wiki_path <path>
```

- `--sections`: lista separada por comas (mismo patrón que `--only` en `bulk_import.py`, con `.strip()` en cada elemento — recordar el bug ya corregido ahí de espacios sin recortar).
- `--slug`: el slug existente en `games/<slug>/` (no bgg_id — el usuario ya conoce los slugs, y evita ambigüedad si el slug no se puede re-derivar igual del nombre actual en BGG).

Pasos:

1. **Leer frontmatter existente** de `wiki_path/games/<slug>/index.md`. Parser mínimo (regex línea por línea, mismo estilo que `extractFrontmatterField` del lado JS) para extraer `bgg_id`, `edition`, `pdf_url` (opcional), `base_game_slug` (opcional). Si el archivo no existe: error claro y `sys.exit(1)` — esta herramienta es solo para juegos ya importados, no reemplaza `add_game.py`.

2. **Re-consultar BGG** con `fetch_game(bgg_id, token=bgg_token)` para refrescar metadata viva (`players`, `weight`, `rank`, `mechanics`, `categories`, `description`, `playing_time`) — el frontmatter no persiste todos estos campos hoy, así que hace falta volver a pedirlos (llamada de red, no LLM — costo despreciable).

3. **Forzar el slug y edición ya existentes**, sin recomputar:
   ```python
   game_data["slug"] = slug            # NO usar el slug recién derivado de fetch_game
   game_data["edition"] = edition_from_frontmatter
   ```
   Si el frontmatter tenía `base_game_slug`, marcar `game_data["is_expansion"] = True` y leer `base_game_name` del `index.md` del juego base (mismo patrón que `find_base_game_in_wiki` en `add_game.py`).

4. **Rulebook**: si el frontmatter tenía `pdf_url`, volver a descargarlo y extraer texto (`fetch_pdf` + `extract_text`, igual que en `add_game.py`) — se usa como grounding en el prompt de *cualquier* sección (`rb` se interpola en las 6), no solo en `rules`/`setup`. Si no había `pdf_url`, generar en modo "llm-only" (mismas advertencias que ya existen).

5. **Generar solo lo pedido**:
   ```python
   sections, failures = compile_game(
       game_data, rulebook_text, pdf_bytes,
       deepseek_provider, gemini_provider,
       only_sections=set(args.sections.split(",")),
   )
   ```

6. **Escribir y commitear solo esas secciones**:
   ```python
   warning = _llm_only_warning(game_data["edition"]) if not rulebook_text else ""
   update_sections(wiki_path, slug, sections, game_data["name"], warning)
   ```
   (`_llm_only_warning` es privada por convención pero ya se importa así en los tests existentes — se reutiliza igual, sin exponerla públicamente.)

7. Si `failures` no está vacío, log de advertencia y `sys.exit(len(failures))` — mismo patrón de salida que `add_game.py`.

## 5. Edge cases

- **Slug no existe en el wiki:** error explícito antes de gastar ninguna llamada LLM.
- **Sección pedida no es una de `SECTION_ORDER`** (typo en `--sections`): validar contra `{"index","setup","rules","teaching","faq","glossary"}` antes de llamar `compile_game`; error claro listando las válidas.
- **`base_game_slug` presente pero el juego base ya no existe en el wiki** (raro, wiki corrupto): tratar igual que `find_base_game_in_wiki` — si no se encuentra, error y `sys.exit(1)` en vez de generar contenido con `base_game_name` vacío.
- **PDF ya no descargable** (URL caída): mismo comportamiento que `add_game.py` hoy — la excepción de `fetch_pdf` propaga y aborta; no hay fallback silencioso a "llm-only" a mitad de camino (evita generar contenido con warning incorrecto).
- **`compile_game` devuelve `sections` vacío** (todas las secciones pedidas fallaron): no llamar `update_sections` con un dict vacío; error y salida sin commit.

## 6. Testing / verificación

- `tests/compiler/test_llm_compiler.py`: nuevo test confirmando que `compile_game(..., only_sections={"teaching"})` genera **solo** `teaching` (`deepseek_provider.generate.call_count == 1`, `set(sections.keys()) == {"teaching"}`), y que `only_sections=None` (o sin pasar el argumento) sigue generando las 6 — regresión sobre `test_compile_game_returns_six_sections`.
- `tests/compiler/test_wiki_writer.py`: nuevo test para `update_sections` — escribe solo los archivos pedidos en un `game_dir` temporal ya existente, no toca `index.md`, y lanza `FileNotFoundError` si el `game_dir` no existe.
- Verificación manual: correr `refresh_sections.py --slug <un-juego-real> --sections teaching --wiki_path <checkout-local-de-mybgg-wiki>` contra un juego real, confirmar por `git diff` en el wiki que solo cambió `teaching.md`, y que el commit generado toca un solo archivo.

## 7. Fuera de alcance

- Bulk refresh (correr esto sobre muchos juegos a la vez) — se invoca manualmente, juego por juego, cuando se vaya a enseñar ese juego específico. Si más adelante hace falta refrescar muchos de una, es una iteración aparte sobre este mismo script (ej. un wrapper que itere sobre slugs), no parte de esta.
- Integrarlo a un GitHub Action — uso local por ahora.
- Migrar/tocar el frontmatter de `index.md` — esta herramienta nunca reescribe `index.md`, solo lee su frontmatter.
