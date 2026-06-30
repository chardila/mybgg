import requests

TAVILY_SEARCH_URL = "https://api.tavily.com/search"


def search_rulebook_pdf(game_name: str, tavily_api_key: str) -> str | None:
    """Search Tavily for a rulebook PDF. Returns first valid PDF URL or None."""
    query = f'"{game_name}" rulebook PDF filetype:pdf'
    try:
        resp = requests.post(
            TAVILY_SEARCH_URL,
            json={"api_key": tavily_api_key, "query": query, "max_results": 5},
            timeout=15,
        )
        resp.raise_for_status()
    except Exception:
        return None

    for result in resp.json().get("results", []):
        url = result.get("url", "")
        if _is_pdf_content(url):
            return url
    return None


def _is_pdf_content(url: str) -> bool:
    try:
        resp = requests.head(url, timeout=10, allow_redirects=True)
        return "application/pdf" in resp.headers.get("Content-Type", "")
    except Exception:
        return False
