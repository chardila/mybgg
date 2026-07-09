# Compiler Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the fidelity of `rules.md` and `setup.md` generation in `scripts/compiler/` by adding a Gemini-based outline pass that splits `rules.md` into per-chapter multimodal calls (so diagrams/illustrations get translated into text and output-token limits stop truncating detail), and by generating `setup.md` from the full PDF multimodally instead of plain extracted text.

**Architecture:** `add_game.py` gains a second LLM provider (`GeminiProvider`, REST-based, multimodal-capable) alongside the existing `DeepSeekProvider`. `compile_game` in `llm_compiler.py` routes `rules` through an outline-pass-then-chapter-calls pipeline (falling back to today's single DeepSeek call if the outline pass fails or no PDF is provided), and routes `setup` through a single Gemini multimodal call on the full PDF (falling back to DeepSeek text-only when no PDF is provided). `index`, `teaching`, `faq`, `glossary` are entirely unchanged. A new `pdf_slicer.py` module extracts page ranges from the source PDF into standalone PDF byte-strings for the chapter calls.

**Tech Stack:** Python 3.13, `pypdf` (new dependency, for page slicing), `requests` (already a dependency, used for Gemini REST calls — no new SDK), `pytest`, `unittest.mock`.

## Global Constraints

- All code changes are under `scripts/compiler/`, `tests/compiler/`, `scripts/requirements.in`/`requirements.txt`, and `.github/workflows/import-game.yml`.
- Run the compiler test suite with `source venv/bin/activate && python -m pytest tests/compiler/ -v` from the repo root — do this after every task.
- Gemini model ID: `gemini-3.1-flash-lite` (already in production use in `worker/src/index.js:131` for the chat tool-calling round — reuse the same model).
- No new SDK for Gemini — implement via direct REST calls using `requests`, per the approved design spec (`docs/superpowers/specs/2026-07-09-compiler-fidelity-design.md`).
- The `llm-only` compilation path (no `--pdf_url`) must remain byte-for-byte unaffected — no outline pass, no multimodal calls, same DeepSeek-only behavior as today.
- `index.md`, `teaching.md`, `faq.md`, `glossary.md` generation is unchanged — same prompts (except a one-sentence addition to the `setup` prompt), same provider, same call pattern.
- The 60 existing tests in `tests/compiler/` must keep passing throughout — update them in place rather than deleting coverage.
- GitHub Actions secrets for this repo require `--repo chardila/mybgg` on any `gh` command (the local git remote resolves to the wrong canonical repo otherwise).

---

## File Map

| File | Change |
|------|--------|
| `scripts/requirements.in` | Add `pypdf` |
| `scripts/requirements.txt` | Regenerate via `pip-compile` |
| `scripts/compiler/pdf_slicer.py` | New — `slice_pages(pdf_bytes, page_ranges) -> bytes` |
| `scripts/compiler/llm_provider.py` | Add `GeminiProvider` (`generate`, `generate_multimodal`) |
| `scripts/compiler/llm_compiler.py` | Add `plan_rules_outline`, `_merge_chapters_to_cap`, `_strip_json_fences`; rewrite `compile_game` with `_compile_rules`/`_compile_setup` helpers; add `_rules_chapter_prompt`; tweak the `setup` prompt text |
| `scripts/compiler/add_game.py` | Construct `GeminiProvider`; thread `pdf_bytes` through to `compile_game` |
| `.github/workflows/import-game.yml` | Pass `GEMINI_API_KEY` secret as env var |
| `tests/compiler/test_pdf_slicer.py` | New |
| `tests/compiler/test_llm_provider.py` | Add `GeminiProvider` tests |
| `tests/compiler/test_llm_compiler.py` | Update 4 existing `compile_game` tests for new signature; add outline-pass and multimodal-routing tests |
| `tests/compiler/test_add_game.py` | Add `GeminiProvider` patch + `GEMINI_API_KEY` env to all `main()` tests; add a `pdf_bytes` passthrough test |

---

## Task 1: PDF page-slicing utility

**Files:**
- Modify: `scripts/requirements.in`
- Modify: `scripts/requirements.txt`
- Create: `scripts/compiler/pdf_slicer.py`
- Test: `tests/compiler/test_pdf_slicer.py`

**Interfaces:**
- Produces: `slice_pages(pdf_bytes: bytes, page_ranges: list[tuple[int, int]]) -> bytes` — 1-indexed, inclusive page ranges; used by `llm_compiler.py` in Task 4.

---

- [ ] **Step 1: Add the `pypdf` dependency**

Open `scripts/requirements.in` and add `pypdf` on its own line, after `pdfplumber`:

```
declxml
pillow
cryptography
pynacl
requests
beautifulsoup4
openai
pdfplumber
pypdf
pytest
```

- [ ] **Step 2: Regenerate `requirements.txt` and install**

```bash
source venv/bin/activate
cd scripts && pip-compile --output-file=requirements.txt requirements.in && cd ..
pip install -r scripts/requirements.txt
```

Expected: `pip-compile` succeeds and `scripts/requirements.txt` gains a `pypdf==<version>` line (and possibly transitive deps). `pip install` reports `pypdf` installed.

- [ ] **Step 3: Write the failing tests**

Create `tests/compiler/test_pdf_slicer.py`:

```python
import io
from pypdf import PdfWriter, PdfReader
from compiler.pdf_slicer import slice_pages


def _make_pdf_bytes(num_pages: int) -> bytes:
    writer = PdfWriter()
    for _ in range(num_pages):
        writer.add_blank_page(width=72, height=72)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_slice_pages_single_range():
    pdf_bytes = _make_pdf_bytes(5)
    result = slice_pages(pdf_bytes, [(2, 4)])
    reader = PdfReader(io.BytesIO(result))
    assert len(reader.pages) == 3


def test_slice_pages_multiple_ranges():
    pdf_bytes = _make_pdf_bytes(6)
    result = slice_pages(pdf_bytes, [(1, 1), (4, 6)])
    reader = PdfReader(io.BytesIO(result))
    assert len(reader.pages) == 4


def test_slice_pages_single_page_range():
    pdf_bytes = _make_pdf_bytes(3)
    result = slice_pages(pdf_bytes, [(2, 2)])
    reader = PdfReader(io.BytesIO(result))
    assert len(reader.pages) == 1
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_pdf_slicer.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'compiler.pdf_slicer'`.

- [ ] **Step 5: Implement `pdf_slicer.py`**

Create `scripts/compiler/pdf_slicer.py`:

```python
import io
from pypdf import PdfReader, PdfWriter


def slice_pages(pdf_bytes: bytes, page_ranges: list[tuple[int, int]]) -> bytes:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    for start, end in page_ranges:
        for page_index in range(start - 1, end):
            writer.add_page(reader.pages[page_index])
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_pdf_slicer.py -v
```

Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add scripts/requirements.in scripts/requirements.txt scripts/compiler/pdf_slicer.py tests/compiler/test_pdf_slicer.py
git commit -m "feat: add PDF page-slicing utility for chapter-based rules compilation"
```

---

## Task 2: GeminiProvider (multimodal-capable LLM provider)

**Files:**
- Modify: `scripts/compiler/llm_provider.py`
- Test: `tests/compiler/test_llm_provider.py`

**Interfaces:**
- Produces: `GeminiProvider(api_key: str, model: str = "gemini-3.1-flash-lite")` with `.generate(system: str, prompt: str) -> str` and `.generate_multimodal(system: str, prompt: str, pdf_bytes: bytes) -> str`; used by `llm_compiler.py` in Tasks 3–4 and `add_game.py` in Task 5.

---

- [ ] **Step 1: Write the failing tests**

Append to `tests/compiler/test_llm_provider.py`:

```python
import base64
from compiler.llm_provider import GeminiProvider


def _mock_gemini_response(text):
    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "candidates": [{"content": {"parts": [{"text": text}]}}]
    }
    mock_resp.raise_for_status.return_value = None
    return mock_resp


def test_gemini_provider_is_llm_provider():
    provider = GeminiProvider(api_key="fake-key")
    assert isinstance(provider, LLMProvider)


def test_gemini_generate_returns_text():
    with patch(
        "compiler.llm_provider.requests.post",
        return_value=_mock_gemini_response("Generated text"),
    ) as mock_post:
        provider = GeminiProvider(api_key="fake-key")
        result = provider.generate(system="You are a helper.", prompt="Write something.")

    assert result == "Generated text"
    call = mock_post.call_args
    assert "gemini-3.1-flash-lite:generateContent" in call.args[0]
    body = call.kwargs["json"]
    assert body["system_instruction"]["parts"][0]["text"] == "You are a helper."
    assert body["contents"][0]["parts"][0]["text"] == "Write something."


def test_gemini_generate_multimodal_includes_inline_pdf():
    pdf_bytes = b"%PDF-fake-bytes"
    with patch(
        "compiler.llm_provider.requests.post",
        return_value=_mock_gemini_response("Chapter content"),
    ) as mock_post:
        provider = GeminiProvider(api_key="fake-key")
        result = provider.generate_multimodal(
            system="Sys", prompt="Describe this chapter.", pdf_bytes=pdf_bytes
        )

    assert result == "Chapter content"
    body = mock_post.call_args.kwargs["json"]
    parts = body["contents"][0]["parts"]
    assert parts[0]["text"] == "Describe this chapter."
    assert parts[1]["inline_data"]["mime_type"] == "application/pdf"
    assert parts[1]["inline_data"]["data"] == base64.b64encode(pdf_bytes).decode("ascii")


def test_gemini_uses_custom_model():
    provider = GeminiProvider(api_key="fake-key", model="gemini-custom")
    assert provider.model == "gemini-custom"


def test_gemini_generate_raises_on_http_error():
    mock_resp = MagicMock()
    mock_resp.raise_for_status.side_effect = Exception("500 error")
    with patch("compiler.llm_provider.requests.post", return_value=mock_resp):
        provider = GeminiProvider(api_key="fake-key")
        try:
            provider.generate(system="s", prompt="p")
            assert False, "expected an exception to propagate"
        except Exception as e:
            assert "500 error" in str(e)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_llm_provider.py -v
```

Expected: the 5 new tests FAIL with `ImportError: cannot import name 'GeminiProvider'`. The 3 existing `DeepSeekProvider` tests still pass.

- [ ] **Step 3: Implement `GeminiProvider`**

Replace the entire contents of `scripts/compiler/llm_provider.py` with:

```python
import base64
from abc import ABC, abstractmethod
import requests
from openai import OpenAI


class LLMProvider(ABC):
    @abstractmethod
    def generate(self, system: str, prompt: str) -> str: ...


class DeepSeekProvider(LLMProvider):
    def __init__(self, api_key: str, model: str = "deepseek-chat"):
        self.client = OpenAI(
            api_key=api_key,
            base_url="https://api.deepseek.com",
        )
        self.model = model

    def generate(self, system: str, prompt: str) -> str:
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        )
        return response.choices[0].message.content or ""


class GeminiProvider(LLMProvider):
    def __init__(self, api_key: str, model: str = "gemini-3.1-flash-lite"):
        self.api_key = api_key
        self.model = model
        self.base_url = "https://generativelanguage.googleapis.com/v1beta"

    def generate(self, system: str, prompt: str) -> str:
        return self._call(system, [{"text": prompt}])

    def generate_multimodal(self, system: str, prompt: str, pdf_bytes: bytes) -> str:
        parts = [
            {"text": prompt},
            {
                "inline_data": {
                    "mime_type": "application/pdf",
                    "data": base64.b64encode(pdf_bytes).decode("ascii"),
                }
            },
        ]
        return self._call(system, parts)

    def _call(self, system: str, parts: list[dict]) -> str:
        url = f"{self.base_url}/models/{self.model}:generateContent?key={self.api_key}"
        body = {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": parts}],
        }
        response = requests.post(url, json=body, timeout=120)
        response.raise_for_status()
        data = response.json()
        return data["candidates"][0]["content"]["parts"][0]["text"]
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_llm_provider.py -v
```

Expected: 8 passed (3 existing DeepSeek + 5 new Gemini).

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/llm_provider.py tests/compiler/test_llm_provider.py
git commit -m "feat: add GeminiProvider for multimodal PDF compilation"
```

---

## Task 3: Rules outline planning pass

**Files:**
- Modify: `scripts/compiler/llm_compiler.py`
- Test: `tests/compiler/test_llm_compiler.py`

**Interfaces:**
- Consumes: `LLMProvider.generate(system, prompt) -> str` (Task 2/existing)
- Produces: `plan_rules_outline(rulebook_text: str, provider: LLMProvider) -> list[dict] | None`, where each dict is `{"titulo": str, "paginas": [int, int]}` and the list has at most 8 entries; `None` means "outline pass unusable, caller should fall back". Used by `compile_game` in Task 4.

---

- [ ] **Step 1: Write the failing tests**

Append to `tests/compiler/test_llm_compiler.py`:

```python
import json


def test_plan_rules_outline_parses_valid_json():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.return_value = json.dumps([
        {"titulo": "Turn Structure", "paginas": [1, 3]},
        {"titulo": "Combat", "paginas": [4, 6]},
    ])
    result = plan_rules_outline("some rulebook text", provider)
    assert result == [
        {"titulo": "Turn Structure", "paginas": [1, 3]},
        {"titulo": "Combat", "paginas": [4, 6]},
    ]


def test_plan_rules_outline_strips_markdown_fences():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.return_value = (
        '```json\n[{"titulo": "Combat", "paginas": [1, 2]}]\n```'
    )
    result = plan_rules_outline("text", provider)
    assert result == [{"titulo": "Combat", "paginas": [1, 2]}]


def test_plan_rules_outline_returns_none_on_malformed_json():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.return_value = "not json at all"
    assert plan_rules_outline("text", provider) is None


def test_plan_rules_outline_returns_none_on_empty_array():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.return_value = "[]"
    assert plan_rules_outline("text", provider) is None


def test_plan_rules_outline_returns_none_when_provider_raises():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.side_effect = Exception("network error")
    assert plan_rules_outline("text", provider) is None


def test_plan_rules_outline_filters_invalid_chapters_but_keeps_valid_ones():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    provider.generate.return_value = json.dumps([
        {"titulo": "Bad", "paginas": "not-a-list"},
        {"titulo": "Good", "paginas": [1, 2]},
    ])
    result = plan_rules_outline("text", provider)
    assert result == [{"titulo": "Good", "paginas": [1, 2]}]


def test_plan_rules_outline_merges_down_to_cap():
    from compiler.llm_compiler import plan_rules_outline
    provider = MagicMock()
    chapters = [{"titulo": f"Ch{i}", "paginas": [i, i]} for i in range(1, 11)]
    provider.generate.return_value = json.dumps(chapters)
    result = plan_rules_outline("text", provider)
    assert len(result) == 8


def test_merge_chapters_to_cap_preserves_page_coverage():
    from compiler.llm_compiler import _merge_chapters_to_cap
    chapters = [{"titulo": f"Ch{i}", "paginas": [i, i]} for i in range(1, 5)]
    result = _merge_chapters_to_cap(chapters, 2)
    assert len(result) == 2
    assert result[0]["paginas"][0] == 1
    assert result[-1]["paginas"][1] == 4
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_llm_compiler.py -v
```

Expected: the 8 new tests FAIL with `ImportError: cannot import name 'plan_rules_outline'`. All existing tests still pass.

- [ ] **Step 3: Implement the outline pass**

Append to the end of `scripts/compiler/llm_compiler.py` (after the existing `compile_game` function):

```python


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
```

Also add `import json` at the very top of `scripts/compiler/llm_compiler.py`, above the existing `from compiler.llm_provider import LLMProvider` line:

```python
import json
from compiler.llm_provider import LLMProvider
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_llm_compiler.py -v
```

Expected: all tests pass (original + 8 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/llm_compiler.py tests/compiler/test_llm_compiler.py
git commit -m "feat: add rules outline planning pass"
```

---

## Task 4: Route rules/setup through multimodal Gemini with fallback

**Files:**
- Modify: `scripts/compiler/llm_compiler.py`
- Test: `tests/compiler/test_llm_compiler.py`

**Interfaces:**
- Consumes: `slice_pages` (Task 1), `GeminiProvider.generate_multimodal` (Task 2), `plan_rules_outline` (Task 3)
- Produces: `compile_game(game_data: dict, rulebook_text: str | None, pdf_bytes: bytes | None, deepseek_provider: LLMProvider, gemini_provider: LLMProvider) -> tuple[dict[str, str], list[str]]` — signature change from the current `compile_game(game_data, rulebook_text, provider)`. Used by `add_game.py` in Task 5.

---

- [ ] **Step 1: Update the 4 existing `compile_game` tests for the new signature**

In `tests/compiler/test_llm_compiler.py`, replace this test:

```python
def test_compile_game_returns_six_sections():
    provider = MagicMock()
    provider.generate.return_value = "# Generated content"

    sections, failures = compile_game(GAME_DATA, rulebook_text=None, provider=provider)

    assert set(sections.keys()) == {"index", "setup", "rules", "teaching", "faq", "glossary"}
    assert failures == []
    assert provider.generate.call_count == 6
```

with:

```python
def test_compile_game_returns_six_sections():
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Generated content"
    gemini_provider = MagicMock()

    sections, failures = compile_game(
        GAME_DATA, rulebook_text=None, pdf_bytes=None,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert set(sections.keys()) == {"index", "setup", "rules", "teaching", "faq", "glossary"}
    assert failures == []
    assert deepseek_provider.generate.call_count == 6
    gemini_provider.generate.assert_not_called()
    gemini_provider.generate_multimodal.assert_not_called()
```

Replace this test:

```python
def test_compile_game_with_rulebook():
    provider = MagicMock()
    provider.generate.return_value = "# Content from rulebook"

    sections, failures = compile_game(GAME_DATA, rulebook_text="Chapter 1: Setup...", provider=provider)

    call_args = provider.generate.call_args_list
    # Rulebook text should appear in at least one prompt
    all_prompts = " ".join(str(call) for call in call_args)
    assert "Chapter 1: Setup" in all_prompts
```

with:

```python
def test_compile_game_with_rulebook_but_no_pdf_bytes_uses_text_path():
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Content from rulebook"
    gemini_provider = MagicMock()

    sections, failures = compile_game(
        GAME_DATA, rulebook_text="Chapter 1: Setup...", pdf_bytes=None,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    call_args = deepseek_provider.generate.call_args_list
    all_prompts = " ".join(str(call) for call in call_args)
    assert "Chapter 1: Setup" in all_prompts
    gemini_provider.generate.assert_not_called()
    gemini_provider.generate_multimodal.assert_not_called()
```

Replace this test:

```python
def test_compile_game_continues_on_section_failure():
    provider = MagicMock()
    provider.generate.side_effect = [
        Exception("API error"),  # index fails
        "# Setup content",       # setup succeeds
        "# Rules content",
        "# Teaching content",
        "# FAQ content",
        "# Glossary content",
    ]

    sections, failures = compile_game(GAME_DATA, rulebook_text=None, provider=provider)

    assert "index" in failures
    assert "setup" in sections
    assert sections["setup"] == "# Setup content"
    assert len(failures) == 1
```

with:

```python
def test_compile_game_continues_on_section_failure():
    deepseek_provider = MagicMock()
    deepseek_provider.generate.side_effect = [
        Exception("API error"),  # index fails
        "# Setup content",       # setup succeeds (no pdf_bytes -> text path)
        "# Rules content",       # rules succeeds (no pdf_bytes -> text path)
        "# Teaching content",
        "# FAQ content",
        "# Glossary content",
    ]
    gemini_provider = MagicMock()

    sections, failures = compile_game(
        GAME_DATA, rulebook_text=None, pdf_bytes=None,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert "index" in failures
    assert "setup" in sections
    assert sections["setup"] == "# Setup content"
    assert len(failures) == 1
```

Replace this test:

```python
def test_compile_game_includes_edition_in_prompts():
    provider = MagicMock()
    provider.generate.return_value = "content"
    game_data_with_edition = {**GAME_DATA, "edition": "2018", "yearpublished": 2018}

    compile_game(game_data_with_edition, rulebook_text=None, provider=provider)

    all_prompts = " ".join(str(call) for call in provider.generate.call_args_list)
    assert "2018" in all_prompts
```

with:

```python
def test_compile_game_includes_edition_in_prompts():
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "content"
    gemini_provider = MagicMock()
    game_data_with_edition = {**GAME_DATA, "edition": "2018", "yearpublished": 2018}

    compile_game(
        game_data_with_edition, rulebook_text=None, pdf_bytes=None,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    all_prompts = " ".join(str(call) for call in deepseek_provider.generate.call_args_list)
    assert "2018" in all_prompts
```

- [ ] **Step 2: Run the tests to verify the updated ones fail (signature mismatch)**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_llm_compiler.py -v
```

Expected: the 4 updated tests FAIL with `TypeError: compile_game() got an unexpected keyword argument 'deepseek_provider'` (or similar). Other tests still pass.

- [ ] **Step 3: Append the new multimodal-routing tests**

Append to the end of `tests/compiler/test_llm_compiler.py`:

```python
def _make_pdf_bytes(num_pages: int) -> bytes:
    import io
    from pypdf import PdfWriter
    writer = PdfWriter()
    for _ in range(num_pages):
        writer.add_blank_page(width=72, height=72)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_compile_game_uses_multimodal_chapters_when_outline_succeeds():
    pdf_bytes = _make_pdf_bytes(6)
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Text section"
    gemini_provider = MagicMock()
    gemini_provider.generate.return_value = json.dumps([
        {"titulo": "Turn Structure", "paginas": [1, 3]},
        {"titulo": "Scoring", "paginas": [4, 6]},
    ])
    gemini_provider.generate_multimodal.return_value = "# Chapter content"

    sections, failures = compile_game(
        GAME_DATA, rulebook_text="Full rulebook text", pdf_bytes=pdf_bytes,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert failures == []
    assert set(sections.keys()) == {"index", "setup", "rules", "teaching", "faq", "glossary"}
    assert sections["rules"] == "# Chapter content\n\n# Chapter content"
    assert gemini_provider.generate_multimodal.call_count == 3  # 2 rules chapters + setup
    assert deepseek_provider.generate.call_count == 4  # index, teaching, faq, glossary
    assert gemini_provider.generate.call_count == 1  # outline pass


def test_compile_game_setup_uses_full_pdf_not_a_slice():
    pdf_bytes = _make_pdf_bytes(4)
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Text section"
    gemini_provider = MagicMock()
    gemini_provider.generate.return_value = json.dumps([{"titulo": "All Rules", "paginas": [1, 4]}])
    gemini_provider.generate_multimodal.return_value = "# Content"

    compile_game(
        GAME_DATA, rulebook_text="Full rulebook text", pdf_bytes=pdf_bytes,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    pdf_args = [call.args[2] for call in gemini_provider.generate_multimodal.call_args_list]
    assert pdf_bytes in pdf_args  # setup call used the unmodified full PDF


def test_compile_game_falls_back_to_text_when_outline_pass_fails():
    pdf_bytes = _make_pdf_bytes(3)
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Text rules"
    gemini_provider = MagicMock()
    gemini_provider.generate.return_value = "not valid json"
    gemini_provider.generate_multimodal.return_value = "# Setup content"

    sections, failures = compile_game(
        GAME_DATA, rulebook_text="Full rulebook text", pdf_bytes=pdf_bytes,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert failures == []
    assert sections["rules"] == "# Text rules"
    assert deepseek_provider.generate.call_count == 5  # index, teaching, faq, glossary, rules fallback
    gemini_provider.generate_multimodal.assert_called_once()  # setup only


def test_compile_game_continues_when_one_rules_chapter_fails():
    pdf_bytes = _make_pdf_bytes(4)
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Text section"
    gemini_provider = MagicMock()
    gemini_provider.generate.return_value = json.dumps([
        {"titulo": "Part A", "paginas": [1, 2]},
        {"titulo": "Part B", "paginas": [3, 4]},
    ])
    gemini_provider.generate_multimodal.side_effect = [
        "# Setup content",          # setup call (compile_game processes setup before rules)
        Exception("gemini error"),  # Part A fails
        "# Part B content",         # Part B succeeds
    ]

    sections, failures = compile_game(
        GAME_DATA, rulebook_text="Full rulebook text", pdf_bytes=pdf_bytes,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert sections["rules"] == "# Part B content"
    assert sections["setup"] == "# Setup content"
    assert any("Part A" in f for f in failures)


def test_compile_game_marks_rules_failed_when_all_chapters_fail():
    pdf_bytes = _make_pdf_bytes(2)
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Text section"
    gemini_provider = MagicMock()
    gemini_provider.generate.return_value = json.dumps([{"titulo": "Part A", "paginas": [1, 2]}])
    gemini_provider.generate_multimodal.side_effect = Exception("boom")

    sections, failures = compile_game(
        GAME_DATA, rulebook_text="Full rulebook text", pdf_bytes=pdf_bytes,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
    )

    assert "rules" not in sections
    assert "rules" in failures
    assert "setup" in failures  # same side_effect exception raised for the setup call too
```

- [ ] **Step 4: Run the tests to verify the new ones fail**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_llm_compiler.py -v
```

Expected: the new tests FAIL (either `TypeError` on the old `compile_game` signature, or assertion errors since the multimodal routing doesn't exist yet).

- [ ] **Step 5: Rewrite `compile_game` and add the routing helpers**

Replace the entire contents of `scripts/compiler/llm_compiler.py` with:

```python
import json
from compiler.llm_provider import LLMProvider
from compiler.pdf_slicer import slice_pages

SYSTEM = (
    "You are a board game knowledge compiler. "
    "Write clear, accurate, well-structured Markdown pages about board games. "
    "Use [[Wiki Link]] syntax for cross-references to mechanics, concepts, and game-specific terms. "
    "Write in English. Be concise and precise. Do not include YAML frontmatter."
)

MAX_RULES_CHAPTERS = 8

SECTION_ORDER = ["index", "setup", "rules", "teaching", "faq", "glossary"]


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
            "If component photos or setup diagrams are visible in the provided material, "
            "translate them into structured Markdown (numbered steps, descriptive lists) "
            "rather than describing that an image exists.\n"
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


def _rules_chapter_prompt(game_data: dict, chapter: dict) -> str:
    name = game_data["name"]
    ex = _expansion_block(game_data)
    return (
        f"{ex}Write the \"{chapter['titulo']}\" section of the Markdown rules reference "
        f"for \"{name}\".\n\n"
        "The attached PDF pages are the authoritative source for this section. Translate "
        "diagrams, component illustrations, and example-of-play images into structured "
        "Markdown text (numbered steps, descriptive lists, or a blockquote example) rather "
        "than describing that an image exists.\n\n"
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
        outline = plan_rules_outline(rulebook_text, gemini_provider)
        if outline:
            chapter_texts = []
            for chapter in outline:
                try:
                    pdf_slice = slice_pages(pdf_bytes, [tuple(chapter["paginas"])])
                    chapter_prompt = _rules_chapter_prompt(game_data, chapter)
                    chapter_texts.append(
                        gemini_provider.generate_multimodal(SYSTEM, chapter_prompt, pdf_slice)
                    )
                except Exception as e:
                    print(f"Warning: failed to generate rules chapter '{chapter['titulo']}': {e}")
                    failures.append(f"rules (chapter: {chapter['titulo']})")
            if chapter_texts:
                sections["rules"] = "\n\n".join(chapter_texts)
            else:
                failures.append("rules")
            return

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
        try:
            sections["setup"] = gemini_provider.generate_multimodal(SYSTEM, prompt, pdf_bytes)
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
) -> tuple[dict[str, str], list[str]]:
    prompts = _prompts(game_data, rulebook_text)
    sections: dict[str, str] = {}
    failures: list[str] = []

    for section_name in SECTION_ORDER:
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
```

- [ ] **Step 6: Run the full compiler test suite to verify everything passes**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_llm_compiler.py -v
```

Expected: all tests pass (4 updated + 5 new multimodal-routing tests + 8 outline-pass tests from Task 3 + the untouched expansion/rulebook-block tests).

- [ ] **Step 7: Commit**

```bash
git add scripts/compiler/llm_compiler.py tests/compiler/test_llm_compiler.py
git commit -m "feat: compile rules/setup via multimodal Gemini chapters with text fallback"
```

---

## Task 5: Wire GeminiProvider and pdf_bytes through add_game.py

**Files:**
- Modify: `scripts/compiler/add_game.py`
- Modify: `tests/compiler/test_add_game.py`

**Interfaces:**
- Consumes: `GeminiProvider` (Task 2), `compile_game(game_data, rulebook_text, pdf_bytes, deepseek_provider, gemini_provider)` (Task 4)
- Produces: `main(...)` reads `GEMINI_API_KEY` from the environment (in addition to the existing `DEEPSEEK_API_KEY`), required unconditionally.

---

- [ ] **Step 1: Update the import line**

In `scripts/compiler/add_game.py`, replace:

```python
from compiler.llm_provider import DeepSeekProvider
```

with:

```python
from compiler.llm_provider import DeepSeekProvider, GeminiProvider
```

- [ ] **Step 2: Construct the Gemini provider and read its key**

Replace:

```python
    bgg_token = os.environ.get("GAMECACHE_BGG_TOKEN")
    deepseek_key = os.environ["DEEPSEEK_API_KEY"]

    provider = DeepSeekProvider(api_key=deepseek_key)
```

with:

```python
    bgg_token = os.environ.get("GAMECACHE_BGG_TOKEN")
    deepseek_key = os.environ["DEEPSEEK_API_KEY"]
    gemini_key = os.environ["GEMINI_API_KEY"]

    provider = DeepSeekProvider(api_key=deepseek_key)
    gemini_provider = GeminiProvider(api_key=gemini_key)
```

- [ ] **Step 3: Keep `pdf_bytes` in scope for both branches, and update the `compile_game` call**

Replace:

```python
    else:
        if not edition:
            print("Error: --edition is required when --pdf_url is not provided.", file=sys.stderr)
            sys.exit(1)
        rulebook_text = None
        source = "llm-only"
        resolved_url = None

    print("Compiling wiki sections (6 LLM calls)...")
    sections, failures = compile_game(game_data, rulebook_text, provider)
```

with:

```python
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
```

- [ ] **Step 4: Update `test_add_game.py`**

Replace the entire contents of `tests/compiler/test_add_game.py` with:

```python
import sys
from unittest.mock import MagicMock, patch
import pytest


GAME_DATA = {
    "id": 237182, "name": "Root", "slug": "root",
    "description": "A game.", "mechanics": ["Area Control"],
    "categories": ["Animals"], "players": "2-4",
    "min_players": 2, "max_players": 4,
    "weight": "3.72", "rank": "21", "playing_time": "60",
    "yearpublished": 2018,
}

FULL_SECTIONS = {
    "index": "# Root", "setup": "Setup", "rules": "Rules",
    "teaching": "Teaching", "faq": "FAQ", "glossary": "Glossary",
}


# ── _resolve_edition unit tests ──────────────────────────────────────────────

def test_resolve_edition_uses_year_by_default():
    from compiler.add_game import _resolve_edition
    assert _resolve_edition({"yearpublished": 2018}, None) == "2018"


def test_resolve_edition_uses_override_when_provided():
    from compiler.add_game import _resolve_edition
    assert _resolve_edition({"yearpublished": 2018}, "Kickstarter Edition") == "kickstarter-edition"


def test_resolve_edition_returns_unknown_when_no_year():
    from compiler.add_game import _resolve_edition
    assert _resolve_edition({"yearpublished": 0}, None) == "unknown"


# ── main() path tests ────────────────────────────────────────────────────────

def test_main_with_pdf_url_uses_pdf_manual_source(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value="Rules text"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game") as mock_write,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GEMINI_API_KEY": "fake-key", "GAMECACHE_BGG_TOKEN": "bgg-token"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
             status="owned", wiki_path=str(tmp_path))

    write_args = mock_write.call_args[0]
    assert write_args[4] == "pdf-manual"
    assert write_args[5] == "https://example.com/root.pdf"


def test_main_with_pdf_url_passes_pdf_bytes_to_compile_game(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF-fake-bytes"),
        patch("compiler.add_game.extract_text", return_value="Rules text"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])) as mock_compile,
        patch("compiler.add_game.write_game"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GEMINI_API_KEY": "fake-key", "GAMECACHE_BGG_TOKEN": "bgg-token"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
             status="owned", wiki_path=str(tmp_path))

    compile_args = mock_compile.call_args[0]
    assert compile_args[2] == b"%PDF-fake-bytes"


def test_main_with_llm_only_path_passes_none_rulebook(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])) as mock_compile,
        patch("compiler.add_game.write_game") as mock_write,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GEMINI_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, edition="2023 Edition",
             status="owned", wiki_path=str(tmp_path))

    compile_args = mock_compile.call_args[0]
    assert compile_args[1] is None  # rulebook_text is None
    assert compile_args[2] is None  # pdf_bytes is None
    write_args = mock_write.call_args[0]
    assert write_args[4] == "llm-only"
    assert write_args[5] is None  # no resolved_url


def test_main_exits_when_no_pdf_url_and_no_edition(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GEMINI_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        with pytest.raises(SystemExit) as exc:
            main(bgg_id=237182, pdf_url=None, edition=None,
                 status="owned", wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_slug_includes_edition_from_year(tmp_path):
    captured = {}
    def capture_write(game_data, *args, **kwargs):
        captured["slug"] = game_data["slug"]
        captured["edition"] = game_data["edition"]

    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value="Rules"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game", side_effect=capture_write),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
             status="owned", wiki_path=str(tmp_path), edition=None)

    assert captured["slug"] == "root-2018"
    assert captured["edition"] == "2018"


def test_main_exits_when_pdf_extracts_no_text(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value=""),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GEMINI_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        with pytest.raises(SystemExit) as exc:
            main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
                 status="owned", wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_slug_uses_edition_override(tmp_path):
    captured = {}
    def capture_write(game_data, *args, **kwargs):
        captured["slug"] = game_data["slug"]

    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game", side_effect=capture_write),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, status="owned",
             wiki_path=str(tmp_path), edition="Kickstarter")

    assert captured["slug"] == "root-kickstarter"


# ── find_base_game_in_wiki unit tests ────────────────────────────────────────

def test_find_base_game_returns_slug_and_name(tmp_path):
    from compiler.add_game import find_base_game_in_wiki
    game_dir = tmp_path / "games" / "pandemic-2008"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        '---\nbgg_id: 30549\nname: "Pandemic"\nslug: pandemic-2008\n---\n\nContent.'
    )
    result = find_base_game_in_wiki(str(tmp_path), 30549)
    assert result == {"slug": "pandemic-2008", "name": "Pandemic"}


def test_find_base_game_returns_none_when_not_found(tmp_path):
    from compiler.add_game import find_base_game_in_wiki
    game_dir = tmp_path / "games" / "root-2018"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        '---\nbgg_id: 237182\nname: "Root"\nslug: root-2018\n---\n'
    )
    result = find_base_game_in_wiki(str(tmp_path), 30549)
    assert result is None


def test_find_base_game_ignores_partial_id_match(tmp_path):
    from compiler.add_game import find_base_game_in_wiki
    game_dir = tmp_path / "games" / "pandemic-2008"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        '---\nbgg_id: 305490\nname: "Other"\nslug: pandemic-2008\n---\n'
    )
    result = find_base_game_in_wiki(str(tmp_path), 30549)
    assert result is None


# ── expansion main() path tests ──────────────────────────────────────────────

EXPANSION_GAME_DATA = {
    "id": 161936, "name": "Pandemic: In the Lab", "slug": "pandemic-in-the-lab",
    "description": "Expansion.", "mechanics": ["Cooperative Game"],
    "categories": ["Expansion"], "players": "2-4",
    "min_players": 2, "max_players": 4,
    "weight": "2.5", "rank": "Not Ranked", "playing_time": "45",
    "yearpublished": 2014,
    "is_expansion": True, "base_game_id": 30549,
}


def test_main_expansion_exits_when_base_game_not_in_wiki(tmp_path):
    (tmp_path / "games").mkdir()
    with (
        patch("compiler.add_game.fetch_game", return_value=EXPANSION_GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value="Rules"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        with pytest.raises(SystemExit) as exc:
            main(bgg_id=161936, pdf_url="https://example.com/exp.pdf",
                 status="owned", wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_expansion_sets_base_game_fields_in_game_data(tmp_path):
    game_dir = tmp_path / "games" / "pandemic-2008"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        '---\nbgg_id: 30549\nname: "Pandemic"\nslug: pandemic-2008\n---\n'
    )
    captured = {}
    def capture_compile(game_data, *args, **kwargs):
        captured.update(game_data)
        return (FULL_SECTIONS, [])

    with (
        patch("compiler.add_game.fetch_game", return_value=EXPANSION_GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value="Rules"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.compile_game", side_effect=capture_compile),
        patch("compiler.add_game.write_game"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=161936, pdf_url="https://example.com/exp.pdf",
             status="owned", wiki_path=str(tmp_path))

    assert captured["base_game_slug"] == "pandemic-2008"
    assert captured["base_game_name"] == "Pandemic"
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_add_game.py -v
```

Expected: all tests pass (original 12 + 1 new `pdf_bytes` passthrough test = 13).

- [ ] **Step 6: Commit**

```bash
git add scripts/compiler/add_game.py tests/compiler/test_add_game.py
git commit -m "feat: wire GeminiProvider and pdf_bytes through add_game.py"
```

---

## Task 6: Add GEMINI_API_KEY to the import workflow

**Files:**
- Modify: `.github/workflows/import-game.yml`

**Interfaces:**
- Consumes: a Google AI Studio API key (the same one already used as the Cloudflare Worker's `GEMINI_API_KEY` secret).

---

- [ ] **Step 1: Add the env var to the workflow**

In `.github/workflows/import-game.yml`, replace:

```yaml
      - name: Import game
        env:
          GAMECACHE_BGG_TOKEN: ${{ secrets.GAMECACHE_BGG_TOKEN }}
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          BGG_ID: ${{ inputs.bgg_id }}
          PDF_URL: ${{ inputs.pdf_url }}
          EDITION: ${{ inputs.edition }}
          STATUS: ${{ inputs.status }}
```

with:

```yaml
      - name: Import game
        env:
          GAMECACHE_BGG_TOKEN: ${{ secrets.GAMECACHE_BGG_TOKEN }}
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          BGG_ID: ${{ inputs.bgg_id }}
          PDF_URL: ${{ inputs.pdf_url }}
          EDITION: ${{ inputs.edition }}
          STATUS: ${{ inputs.status }}
```

- [ ] **Step 2: Add the `GEMINI_API_KEY` secret to the `mybgg` repo (manual, one-time)**

This is a manual step — GitHub secrets can't be read back to verify, so use the same key value already configured for the Cloudflare Worker (Google AI Studio key, starts with `AIza`):

```bash
gh secret set GEMINI_API_KEY --repo chardila/mybgg
```

Paste the key when prompted. Confirm it was set:

```bash
gh secret list --repo chardila/mybgg
```

Expected: `GEMINI_API_KEY` appears in the list.

- [ ] **Step 3: Commit the workflow change**

```bash
git add .github/workflows/import-game.yml
git commit -m "feat: pass GEMINI_API_KEY secret to import-game workflow"
```

---

## Task 7: Full verification

**Files:** none (verification only)

---

- [ ] **Step 1: Run the entire compiler test suite**

```bash
source venv/bin/activate && python -m pytest tests/compiler/ -v
```

Expected: all tests pass — 60 original tests + new tests from Tasks 1–5 (pdf_slicer: 3, llm_provider: 5, llm_compiler outline pass: 8, llm_compiler multimodal routing: 5, add_game: 1), with no regressions in the untouched `index`/`teaching`/`faq`/`glossary`/`llm-only` behavior.

- [ ] **Step 2: Confirm no other test suites were touched**

```bash
git status
```

Expected: only files listed in the File Map above are modified/created — nothing under `worker/`, `scripts/gamecache/`, or `tests/` outside `tests/compiler/`.
