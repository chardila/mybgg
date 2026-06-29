import requests


def fetch_pdf(pdf_url: str) -> bytes:
    response = requests.get(pdf_url, timeout=60)
    response.raise_for_status()
    return response.content
