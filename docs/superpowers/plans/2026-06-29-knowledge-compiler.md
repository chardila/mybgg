# Knowledge Compiler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI tool (triggered via GitHub Actions) that imports a board game into a private Markdown wiki by fetching BGG metadata, optionally parsing a PDF rulebook, and generating structured wiki pages via DeepSeek.

**Architecture:** A Python module `scripts/compiler/` adds to the existing mybgg repo alongside `scripts/gamecache/`. A GitHub Actions `workflow_dispatch` workflow runs the compiler in the cloud and commits the generated Markdown files to a separate private repo (`mybgg-wiki`). The wiki is Obsidian-compatible and is the single source of truth for game knowledge.

**Tech Stack:** Python 3.12, `openai` SDK (pointed at DeepSeek), `pdfplumber`, `pytest`, `requests` (already present), GitHub Actions, Git.

## Global Constraints

- Python 3.12 (matches existing workflow: `actions/setup-python@v6` with `python-version: '3.12'`)
- GitHub Actions versions: `actions/checkout@v6`, `actions/setup-python@v6`
- All new modules live under `scripts/compiler/`; tests under `tests/compiler/`
- DeepSeek model: `deepseek-chat` (DeepSeek V3) via `https://api.deepseek.com`
- LLM provider is accessed only through the `LLMProvider` abstract interface — never directly in business logic
- Wiki files use Obsidian-style wiki links: `[[Term Name]]`
- Frontmatter is YAML, top of `index.md` only; other section files have no frontmatter
- `source` field in frontmatter must be `pdf` or `ai-generated` — no other values
- `status` must be one of: `owned`, `wishlist`, `borrowed`, `friend`, `played`, `archived`
- Secrets accessed via environment variables: `DEEPSEEK_API_KEY`, `WIKI_GITHUB_TOKEN`, `GAMECACHE_BGG_TOKEN`

---

## File Map

```
scripts/requirements.in               modify: add openai, pdfplumber, pytest
scripts/requirements.txt              regenerate from requirements.in
scripts/compiler/__init__.py          create: empty package marker
scripts/compiler/add_game.py          create: CLI entrypoint / orchestrator
scripts/compiler/bgg_fetcher.py       create: fetch game metadata from BGG API
scripts/compiler/pdf_fetcher.py       create: download PDF bytes from URL
scripts/compiler/pdf_parser.py        create: extract plain text from PDF bytes
scripts/compiler/llm_provider.py      create: LLMProvider ABC + DeepSeekProvider
scripts/compiler/llm_compiler.py      create: generate 6 wiki sections via LLM
scripts/compiler/wiki_writer.py       create: write .md files + git commit/push
.github/workflows/import-game.yml     create: workflow_dispatch trigger
tests/conftest.py                     create: add scripts/ to sys.path for tests
tests/compiler/__init__.py            create: empty package marker
tests/compiler/test_bgg_fetcher.py    create
tests/compiler/test_pdf_fetcher.py    create
tests/compiler/test_pdf_parser.py     create
tests/compiler/test_llm_provider.py   create
tests/compiler/test_llm_compiler.py   create
tests/compiler/test_wiki_writer.py    create
```

---

## Task 1: Wiki Repo and Secrets Setup

**Files:** No code files — manual setup steps.

This task has no automated tests; completion is verified by the smoke test in Task 8.

- [ ] **Step 1: Create the private wiki repo on GitHub**

  Go to https://github.com/new and create a new **private** repository named `mybgg-wiki` under account `chardila`. Initialize with a README.

- [ ] **Step 2: Clone the wiki repo locally**

  ```bash
  git clone https://github.com/chardila/mybgg-wiki.git ~/mybgg-wiki
  ```

- [ ] **Step 3: Create the initial directory structure in mybgg-wiki**

  ```bash
  mkdir -p ~/mybgg-wiki/games ~/mybgg-wiki/mechanics ~/mybgg-wiki/glossary
  touch ~/mybgg-wiki/games/.gitkeep ~/mybgg-wiki/mechanics/.gitkeep ~/mybgg-wiki/glossary/.gitkeep
  git -C ~/mybgg-wiki add .
  git -C ~/mybgg-wiki commit -m "chore: initial wiki structure"
  git -C ~/mybgg-wiki push
  ```

- [ ] **Step 4: Create a Personal Access Token with repo scope**

  Go to https://github.com/settings/tokens/new, select **Classic**, enable the `repo` scope, name it `mybgg-wiki-writer`. Copy the token.

- [ ] **Step 5: Add secrets to mybgg repo**

  Go to https://github.com/chardila/mybgg/settings/secrets/actions and add:
  - `WIKI_GITHUB_TOKEN` → paste the PAT from Step 4
  - `DEEPSEEK_API_KEY` → your DeepSeek API key from https://platform.deepseek.com/api_keys

  `GAMECACHE_BGG_TOKEN` already exists — no action needed.

---

## Task 2: Dependencies and Test Infrastructure

**Files:**
- Modify: `scripts/requirements.in`
- Regenerate: `scripts/requirements.txt`
- Create: `scripts/compiler/__init__.py`
- Create: `tests/conftest.py`
- Create: `tests/compiler/__init__.py`

**Interfaces:**
- Produces: `pytest` available, `openai` and `pdfplumber` importable, `scripts/compiler` is a package

- [ ] **Step 1: Add dependencies to requirements.in**

  Edit `scripts/requirements.in` to add three lines:

  ```
  declxml
  pillow
  cryptography
  pynacl
  openai
  pdfplumber
  pytest
  ```

- [ ] **Step 2: Regenerate requirements.txt**

  ```bash
  cd scripts
  pip install pip-tools
  pip-compile requirements.in --output-file requirements.txt
  cd ..
  ```

  If `pip-compile` is not available or causes issues, install manually and freeze:

  ```bash
  pip install openai pdfplumber pytest
  pip freeze > scripts/requirements.txt
  ```

  Expected: `scripts/requirements.txt` now contains `openai`, `pdfplumber`, `pytest` entries.

- [ ] **Step 3: Create the compiler package marker**

  Create `scripts/compiler/__init__.py` with empty content:

  ```python
  ```

- [ ] **Step 4: Create test infrastructure**

  Create `tests/conftest.py`:

  ```python
  import sys
  from pathlib import Path

  sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
  ```

  Create `tests/compiler/__init__.py` with empty content:

  ```python
  ```

- [ ] **Step 5: Verify pytest discovers tests**

  ```bash
  pip install -r scripts/requirements.txt
  pytest tests/ --collect-only
  ```

  Expected output: `no tests ran` (no tests yet) with exit code 0 or 5 (no tests collected). No import errors.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/requirements.in scripts/requirements.txt scripts/compiler/__init__.py tests/conftest.py tests/compiler/__init__.py
  git commit -m "chore: add compiler package and test infrastructure"
  ```

---

## Task 3: LLM Provider Abstraction

**Files:**
- Create: `scripts/compiler/llm_provider.py`
- Create: `tests/compiler/test_llm_provider.py`

**Interfaces:**
- Produces:
  ```python
  class LLMProvider(ABC):
      def generate(self, system: str, prompt: str) -> str: ...

  class DeepSeekProvider(LLMProvider):
      def __init__(self, api_key: str, model: str = "deepseek-chat"): ...
      def generate(self, system: str, prompt: str) -> str: ...
  ```

- [ ] **Step 1: Write the failing tests**

  Create `tests/compiler/test_llm_provider.py`:

  ```python
  from unittest.mock import MagicMock, patch
  from compiler.llm_provider import DeepSeekProvider, LLMProvider


  def test_deepseek_provider_is_llm_provider():
      provider = DeepSeekProvider(api_key="fake-key")
      assert isinstance(provider, LLMProvider)


  def test_deepseek_generate_returns_content():
      mock_choice = MagicMock()
      mock_choice.message.content = "Generated wiki content"
      mock_completion = MagicMock()
      mock_completion.choices = [mock_choice]

      with patch("compiler.llm_provider.OpenAI") as mock_openai_cls:
          mock_client = MagicMock()
          mock_client.chat.completions.create.return_value = mock_completion
          mock_openai_cls.return_value = mock_client

          provider = DeepSeekProvider(api_key="fake-key")
          result = provider.generate(system="You are a helper.", prompt="Write something.")

      assert result == "Generated wiki content"
      mock_client.chat.completions.create.assert_called_once_with(
          model="deepseek-chat",
          messages=[
              {"role": "system", "content": "You are a helper."},
              {"role": "user", "content": "Write something."},
          ],
      )


  def test_deepseek_uses_custom_model():
      with patch("compiler.llm_provider.OpenAI"):
          provider = DeepSeekProvider(api_key="fake-key", model="deepseek-reasoner")
          assert provider.model == "deepseek-reasoner"
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  pytest tests/compiler/test_llm_provider.py -v
  ```

  Expected: `ImportError: cannot import name 'DeepSeekProvider' from 'compiler.llm_provider'`

- [ ] **Step 3: Implement llm_provider.py**

  Create `scripts/compiler/llm_provider.py`:

  ```python
  from abc import ABC, abstractmethod
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
          return response.choices[0].message.content
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  pytest tests/compiler/test_llm_provider.py -v
  ```

  Expected: `3 passed`

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/compiler/llm_provider.py tests/compiler/test_llm_provider.py
  git commit -m "feat: add LLM provider abstraction with DeepSeek implementation"
  ```

---

## Task 4: BGG Fetcher

**Files:**
- Create: `scripts/compiler/bgg_fetcher.py`
- Create: `tests/compiler/test_bgg_fetcher.py`

**Interfaces:**
- Consumes: `gamecache.bgg_client.BGGClient` (existing)
- Produces:
  ```python
  def fetch_game(bgg_id: int, token: str | None = None) -> dict:
      # Returns:
      # {
      #   "id": int, "name": str, "slug": str,
      #   "description": str, "mechanics": list[str],
      #   "categories": list[str], "players": str,
      #   "min_players": int, "max_players": int,
      #   "weight": str, "rank": str, "playing_time": str,
      # }
  ```

- [ ] **Step 1: Write the failing tests**

  Create `tests/compiler/test_bgg_fetcher.py`:

  ```python
  from unittest.mock import MagicMock, patch
  import pytest
  from compiler.bgg_fetcher import fetch_game, _to_slug


  BGG_GAME_DATA = {
      "id": 237182,
      "type": "boardgame",
      "name": "Root",
      "description": "A game of adventure and war.",
      "mechanics": ["Area Control", "Hand Management"],
      "categories": ["Animals", "Fighting"],
      "suggested_numplayers": [("2", "best"), ("3", "recommended")],
      "min_players": "2",
      "max_players": "4",
      "weight": "3.72",
      "rank": "21",
      "playing_time": "60",
      "usersrated": "50000",
      "numowned": "100000",
      "rating": "8.1",
      "expansions": [],
  }


  def test_fetch_game_returns_dict():
      with patch("compiler.bgg_fetcher.BGGClient") as mock_cls:
          mock_client = MagicMock()
          mock_client.game_list.return_value = [BGG_GAME_DATA]
          mock_cls.return_value = mock_client

          result = fetch_game(237182)

      assert result["id"] == 237182
      assert result["name"] == "Root"
      assert result["slug"] == "root"
      assert result["mechanics"] == ["Area Control", "Hand Management"]
      assert result["players"] == "2-4"


  def test_fetch_game_raises_for_unknown_id():
      with patch("compiler.bgg_fetcher.BGGClient") as mock_cls:
          mock_client = MagicMock()
          mock_client.game_list.return_value = []
          mock_cls.return_value = mock_client

          with pytest.raises(ValueError, match="not found"):
              fetch_game(999999)


  def test_to_slug_simple():
      assert _to_slug("Root") == "root"


  def test_to_slug_with_spaces():
      assert _to_slug("Terraforming Mars") == "terraforming-mars"


  def test_to_slug_with_special_chars():
      assert _to_slug("Arkham Horror: The Card Game") == "arkham-horror-the-card-game"
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  pytest tests/compiler/test_bgg_fetcher.py -v
  ```

  Expected: `ImportError: cannot import name 'fetch_game' from 'compiler.bgg_fetcher'`

- [ ] **Step 3: Implement bgg_fetcher.py**

  Create `scripts/compiler/bgg_fetcher.py`:

  ```python
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
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  pytest tests/compiler/test_bgg_fetcher.py -v
  ```

  Expected: `5 passed`

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/compiler/bgg_fetcher.py tests/compiler/test_bgg_fetcher.py
  git commit -m "feat: add BGG fetcher for game metadata"
  ```

---

## Task 5: PDF Fetcher and Parser

**Files:**
- Create: `scripts/compiler/pdf_fetcher.py`
- Create: `scripts/compiler/pdf_parser.py`
- Create: `tests/compiler/test_pdf_fetcher.py`
- Create: `tests/compiler/test_pdf_parser.py`

**Interfaces:**
- Produces:
  ```python
  def fetch_pdf(pdf_url: str) -> bytes: ...
  def extract_text(pdf_bytes: bytes) -> str: ...
  ```

- [ ] **Step 1: Write the failing tests**

  Create `tests/compiler/test_pdf_fetcher.py`:

  ```python
  from unittest.mock import MagicMock, patch
  import pytest
  from compiler.pdf_fetcher import fetch_pdf


  def test_fetch_pdf_returns_bytes():
      mock_response = MagicMock()
      mock_response.content = b"%PDF-1.4 fake content"
      mock_response.headers = {"content-type": "application/pdf"}
      mock_response.raise_for_status = MagicMock()

      with patch("compiler.pdf_fetcher.requests.get", return_value=mock_response):
          result = fetch_pdf("https://example.com/rulebook.pdf")

      assert result == b"%PDF-1.4 fake content"


  def test_fetch_pdf_raises_on_http_error():
      mock_response = MagicMock()
      mock_response.raise_for_status.side_effect = Exception("404 Not Found")

      with patch("compiler.pdf_fetcher.requests.get", return_value=mock_response):
          with pytest.raises(Exception, match="404"):
              fetch_pdf("https://example.com/missing.pdf")
  ```

  Create `tests/compiler/test_pdf_parser.py`:

  ```python
  from unittest.mock import MagicMock, patch
  from compiler.pdf_parser import extract_text


  def test_extract_text_joins_pages():
      mock_page1 = MagicMock()
      mock_page1.extract_text.return_value = "Page one content"
      mock_page2 = MagicMock()
      mock_page2.extract_text.return_value = "Page two content"

      mock_pdf = MagicMock()
      mock_pdf.__enter__ = lambda s: mock_pdf
      mock_pdf.__exit__ = MagicMock(return_value=False)
      mock_pdf.pages = [mock_page1, mock_page2]

      with patch("compiler.pdf_parser.pdfplumber.open", return_value=mock_pdf):
          result = extract_text(b"fake pdf bytes")

      assert result == "Page one content\n\nPage two content"


  def test_extract_text_handles_none_page():
      mock_page = MagicMock()
      mock_page.extract_text.return_value = None

      mock_pdf = MagicMock()
      mock_pdf.__enter__ = lambda s: mock_pdf
      mock_pdf.__exit__ = MagicMock(return_value=False)
      mock_pdf.pages = [mock_page]

      with patch("compiler.pdf_parser.pdfplumber.open", return_value=mock_pdf):
          result = extract_text(b"fake pdf bytes")

      assert result == ""
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  pytest tests/compiler/test_pdf_fetcher.py tests/compiler/test_pdf_parser.py -v
  ```

  Expected: `ImportError` for both modules.

- [ ] **Step 3: Implement pdf_fetcher.py**

  Create `scripts/compiler/pdf_fetcher.py`:

  ```python
  import requests


  def fetch_pdf(pdf_url: str) -> bytes:
      response = requests.get(pdf_url, timeout=60)
      response.raise_for_status()
      return response.content
  ```

- [ ] **Step 4: Implement pdf_parser.py**

  Create `scripts/compiler/pdf_parser.py`:

  ```python
  import io
  import pdfplumber


  def extract_text(pdf_bytes: bytes) -> str:
      with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
          pages = [page.extract_text() or "" for page in pdf.pages]
      return "\n\n".join(pages)
  ```

- [ ] **Step 5: Run tests to verify they pass**

  ```bash
  pytest tests/compiler/test_pdf_fetcher.py tests/compiler/test_pdf_parser.py -v
  ```

  Expected: `4 passed`

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/compiler/pdf_fetcher.py scripts/compiler/pdf_parser.py \
          tests/compiler/test_pdf_fetcher.py tests/compiler/test_pdf_parser.py
  git commit -m "feat: add PDF fetcher and text extractor"
  ```

---

## Task 6: LLM Compiler

**Files:**
- Create: `scripts/compiler/llm_compiler.py`
- Create: `tests/compiler/test_llm_compiler.py`

**Interfaces:**
- Consumes: `LLMProvider` from `compiler.llm_provider`
- Produces:
  ```python
  def compile_game(
      game_data: dict,
      rulebook_text: str | None,
      provider: LLMProvider,
  ) -> tuple[dict[str, str], list[str]]:
      # Returns (sections, failures)
      # sections: {"index": str, "setup": str, "rules": str,
      #             "teaching": str, "faq": str, "glossary": str}
      # failures: list of section names that raised an exception
  ```

- [ ] **Step 1: Write the failing tests**

  Create `tests/compiler/test_llm_compiler.py`:

  ```python
  from unittest.mock import MagicMock
  from compiler.llm_compiler import compile_game


  GAME_DATA = {
      "id": 237182,
      "name": "Root",
      "slug": "root",
      "description": "A game of adventure.",
      "mechanics": ["Area Control"],
      "categories": ["Animals"],
      "players": "2-4",
      "min_players": 2,
      "max_players": 4,
      "weight": "3.72",
      "rank": "21",
      "playing_time": "60",
  }


  def test_compile_game_returns_six_sections():
      provider = MagicMock()
      provider.generate.return_value = "# Generated content"

      sections, failures = compile_game(GAME_DATA, rulebook_text=None, provider=provider)

      assert set(sections.keys()) == {"index", "setup", "rules", "teaching", "faq", "glossary"}
      assert failures == []
      assert provider.generate.call_count == 6


  def test_compile_game_with_rulebook():
      provider = MagicMock()
      provider.generate.return_value = "# Content from rulebook"

      sections, failures = compile_game(GAME_DATA, rulebook_text="Chapter 1: Setup...", provider=provider)

      call_args = provider.generate.call_args_list
      # Rulebook text should appear in at least one prompt
      all_prompts = " ".join(str(call) for call in call_args)
      assert "Chapter 1: Setup" in all_prompts


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

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  pytest tests/compiler/test_llm_compiler.py -v
  ```

  Expected: `ImportError: cannot import name 'compile_game'`

- [ ] **Step 3: Implement llm_compiler.py**

  Create `scripts/compiler/llm_compiler.py`:

  ```python
  from compiler.llm_provider import LLMProvider

  SYSTEM = (
      "You are a board game knowledge compiler. "
      "Write clear, accurate, well-structured Markdown pages about board games. "
      "Use [[Wiki Link]] syntax for cross-references to mechanics, concepts, and game-specific terms. "
      "Write in English. Be concise and precise. Do not include YAML frontmatter."
  )

  def _rulebook_block(rulebook_text: str | None) -> str:
      if rulebook_text:
          return f"\nRulebook text (authoritative source):\n---\n{rulebook_text}\n---\n"
      return "\nNo rulebook provided. Use your knowledge of the game.\n"


  def _prompts(game_data: dict, rulebook_text: str | None) -> dict[str, str]:
      name = game_data["name"]
      rb = _rulebook_block(rulebook_text)
      meta = (
          f"- Players: {game_data['players']}\n"
          f"- Playing time: {game_data['playing_time']} min\n"
          f"- Weight: {game_data['weight']}/5\n"
          f"- BGG Rank: {game_data['rank']}\n"
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
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  pytest tests/compiler/test_llm_compiler.py -v
  ```

  Expected: `3 passed`

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/compiler/llm_compiler.py tests/compiler/test_llm_compiler.py
  git commit -m "feat: add LLM compiler with 6-section game wiki generation"
  ```

---

## Task 7: Wiki Writer

**Files:**
- Create: `scripts/compiler/wiki_writer.py`
- Create: `tests/compiler/test_wiki_writer.py`

**Interfaces:**
- Produces:
  ```python
  def write_game(
      game_data: dict,
      sections: dict[str, str],
      wiki_path: str,
      status: str,
      source: str,
      pdf_url: str | None = None,
  ) -> None:
      # Creates games/{slug}/*.md in wiki_path
      # Runs git add + commit + push
  ```

- [ ] **Step 1: Write the failing tests**

  Create `tests/compiler/test_wiki_writer.py`:

  ```python
  import os
  import subprocess
  from unittest.mock import patch
  from pathlib import Path
  import pytest
  from compiler.wiki_writer import write_game, _build_frontmatter


  GAME_DATA = {
      "id": 237182,
      "name": "Root",
      "slug": "root",
      "mechanics": ["Area Control", "Hand Management"],
      "players": "2-4",
      "weight": "3.72",
      "rank": "21",
  }

  SECTIONS = {
      "index": "## Overview\n\nRoot is a game about...",
      "setup": "## Setup\n\nPlace the board...",
      "rules": "## Rules\n\nEach turn...",
      "teaching": "## Teaching\n\nStart by...",
      "faq": "## FAQ\n\nQ: Can I...",
      "glossary": "## Clearings\n\nA territory type.",
  }


  def test_write_game_creates_directory(tmp_path):
      with patch("compiler.wiki_writer._git_commit_and_push"):
          write_game(GAME_DATA, SECTIONS, str(tmp_path), "owned", "pdf",
                     "https://example.com/root.pdf")

      assert (tmp_path / "games" / "root").is_dir()


  def test_write_game_creates_all_section_files(tmp_path):
      with patch("compiler.wiki_writer._git_commit_and_push"):
          write_game(GAME_DATA, SECTIONS, str(tmp_path), "owned", "pdf")

      game_dir = tmp_path / "games" / "root"
      for section in ["index", "setup", "rules", "teaching", "faq", "glossary"]:
          assert (game_dir / f"{section}.md").exists()


  def test_index_md_has_frontmatter(tmp_path):
      with patch("compiler.wiki_writer._git_commit_and_push"):
          write_game(GAME_DATA, SECTIONS, str(tmp_path), "owned", "pdf")

      content = (tmp_path / "games" / "root" / "index.md").read_text()
      assert content.startswith("---\n")
      assert "bgg_id: 237182" in content
      assert "status: owned" in content
      assert "source: pdf" in content


  def test_other_sections_have_no_frontmatter(tmp_path):
      with patch("compiler.wiki_writer._git_commit_and_push"):
          write_game(GAME_DATA, SECTIONS, str(tmp_path), "owned", "ai-generated")

      setup_content = (tmp_path / "games" / "root" / "setup.md").read_text()
      assert not setup_content.startswith("---")
      assert setup_content == SECTIONS["setup"]


  def test_build_frontmatter_includes_pdf_url():
      from datetime import date
      fm = _build_frontmatter(GAME_DATA, "owned", "pdf", "https://example.com/root.pdf")
      assert "pdf_url: https://example.com/root.pdf" in fm


  def test_build_frontmatter_omits_pdf_url_when_none():
      fm = _build_frontmatter(GAME_DATA, "ai-generated", "ai-generated", None)
      assert "pdf_url" not in fm
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  pytest tests/compiler/test_wiki_writer.py -v
  ```

  Expected: `ImportError: cannot import name 'write_game'`

- [ ] **Step 3: Implement wiki_writer.py**

  Create `scripts/compiler/wiki_writer.py`:

  ```python
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
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  pytest tests/compiler/test_wiki_writer.py -v
  ```

  Expected: `6 passed`

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/compiler/wiki_writer.py tests/compiler/test_wiki_writer.py
  git commit -m "feat: add wiki writer with frontmatter generation and git push"
  ```

---

## Task 8: Orchestrator CLI and GitHub Actions Workflow

**Files:**
- Create: `scripts/compiler/add_game.py`
- Create: `.github/workflows/import-game.yml`
- Create: `tests/compiler/test_add_game.py`

**Interfaces:**
- Consumes: all modules from Tasks 3–7
- Produces: CLI `python scripts/compiler/add_game.py --bgg_id INT --status STR [--pdf_url STR] --wiki_path STR`

- [ ] **Step 1: Write the failing integration test**

  Create `tests/compiler/test_add_game.py`:

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
  }


  def test_main_with_pdf_url(tmp_path):
      with (
          patch("compiler.add_game.fetch_game", return_value=GAME_DATA) as mock_fetch,
          patch("compiler.add_game.fetch_pdf", return_value=b"%PDF fake") as mock_pdf,
          patch("compiler.add_game.extract_text", return_value="Rules text") as mock_extract,
          patch("compiler.add_game.DeepSeekProvider") as mock_provider_cls,
          patch("compiler.add_game.compile_game", return_value=({"index": "# Root", "setup": "Setup", "rules": "Rules", "teaching": "Teaching", "faq": "FAQ", "glossary": "Glossary"}, [])) as mock_compile,
          patch("compiler.add_game.write_game") as mock_write,
          patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GAMECACHE_BGG_TOKEN": "bgg-token"}),
      ):
          from compiler.add_game import main
          main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
               status="owned", wiki_path=str(tmp_path))

      mock_fetch.assert_called_once_with(237182, token="bgg-token")
      mock_pdf.assert_called_once_with("https://example.com/root.pdf")
      mock_extract.assert_called_once_with(b"%PDF fake")
      mock_compile.assert_called_once()
      mock_write.assert_called_once()
      _, write_kwargs = mock_write.call_args
      assert write_kwargs.get("source") == "pdf" or mock_write.call_args[0][4] == "pdf"


  def test_main_without_pdf_url(tmp_path):
      with (
          patch("compiler.add_game.fetch_game", return_value=GAME_DATA),
          patch("compiler.add_game.DeepSeekProvider"),
          patch("compiler.add_game.compile_game", return_value=({"index": "# Root", "setup": "S", "rules": "R", "teaching": "T", "faq": "F", "glossary": "G"}, [])) as mock_compile,
          patch("compiler.add_game.write_game") as mock_write,
          patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GAMECACHE_BGG_TOKEN": ""}),
      ):
          from compiler.add_game import main
          main(bgg_id=237182, pdf_url=None, status="wishlist", wiki_path=str(tmp_path))

      # compile_game called with rulebook_text=None
      compile_args = mock_compile.call_args[0]
      assert compile_args[1] is None
      # source should be ai-generated
      write_args = mock_write.call_args[0]
      assert write_args[4] == "ai-generated"
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  pytest tests/compiler/test_add_game.py -v
  ```

  Expected: `ImportError: cannot import name 'main' from 'compiler.add_game'`

- [ ] **Step 3: Implement add_game.py**

  Create `scripts/compiler/add_game.py`:

  ```python
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

      if failures:
          print(f"Warning: {len(failures)} section(s) failed: {failures}")

      print(f"Writing wiki files to {wiki_path}/games/{game_data['slug']}/...")
      write_game(game_data, sections, wiki_path, status, source, pdf_url)

      print(f"Done! Wiki for '{game_data['name']}' committed to {wiki_path}.")
      if failures:
          print(f"Re-run to retry failed sections: {failures}")


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
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  pytest tests/compiler/test_add_game.py -v
  ```

  Expected: `2 passed`

- [ ] **Step 5: Run the full test suite**

  ```bash
  pytest tests/ -v
  ```

  Expected: all tests pass (at minimum 20 tests).

- [ ] **Step 6: Create the GitHub Actions workflow**

  Create `.github/workflows/import-game.yml`:

  ```yaml
  name: Import game to wiki

  on:
    workflow_dispatch:
      inputs:
        bgg_id:
          description: 'BGG Game ID (number in the BGG URL, e.g. 237182 for Root)'
          required: true
          type: string
        pdf_url:
          description: 'Direct URL to the rulebook PDF (leave empty to use LLM knowledge)'
          required: false
          type: string
          default: ''
        status:
          description: 'Ownership status'
          required: true
          type: choice
          default: 'owned'
          options:
            - owned
            - wishlist
            - borrowed
            - friend
            - played
            - archived

  jobs:
    import:
      runs-on: ubuntu-latest
      steps:
        - name: Checkout mybgg (code)
          uses: actions/checkout@v6

        - name: Checkout mybgg-wiki (content)
          uses: actions/checkout@v6
          with:
            repository: chardila/mybgg-wiki
            path: wiki
            token: ${{ secrets.WIKI_GITHUB_TOKEN }}

        - name: Setup Python
          uses: actions/setup-python@v6
          with:
            python-version: '3.12'
            cache: 'pip'

        - name: Install dependencies
          run: pip install -r scripts/requirements.txt

        - name: Configure git identity for wiki commits
          run: |
            git -C wiki config user.name "GitHub Actions"
            git -C wiki config user.email "actions@github.com"

        - name: Import game
          env:
            GAMECACHE_BGG_TOKEN: ${{ secrets.GAMECACHE_BGG_TOKEN }}
            DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
            BGG_ID: ${{ inputs.bgg_id }}
            PDF_URL: ${{ inputs.pdf_url }}
            STATUS: ${{ inputs.status }}
          run: |
            ARGS="--bgg_id $BGG_ID --status $STATUS --wiki_path wiki"
            if [ -n "$PDF_URL" ]; then
              ARGS="$ARGS --pdf_url $PDF_URL"
            fi
            python scripts/compiler/add_game.py $ARGS
  ```

- [ ] **Step 7: Commit everything**

  ```bash
  git add scripts/compiler/add_game.py .github/workflows/import-game.yml \
          tests/compiler/test_add_game.py
  git commit -m "feat: add orchestrator CLI and GitHub Actions import workflow"
  ```

- [ ] **Step 8: Smoke test — trigger the workflow from GitHub Actions UI**

  1. Push all commits to GitHub: `git push`
  2. Go to https://github.com/chardila/mybgg/actions
  3. Select **"Import game to wiki"** workflow
  4. Click **"Run workflow"**
  5. Fill in:
     - `bgg_id`: `30549` (Pandemic — simple, well-known, LLM knows it well)
     - `pdf_url`: leave empty
     - `status`: `owned`
  6. Click **"Run workflow"**
  7. Watch the run complete (expect ~2-3 minutes for 6 LLM calls)
  8. Verify in https://github.com/chardila/mybgg-wiki that `games/pandemic/` was created with all 6 `.md` files
  9. Clone or pull the wiki locally and open in Obsidian to verify the vault works
