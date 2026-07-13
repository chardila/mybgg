import requests

# A default requests User-Agent gets Cloudflare-blocked (or served a challenge
# page instead of the file) on some hosts more often than a browser-like one —
# notably boardgamegeek.com/file/download_redirect/... links, which redirect
# to a short-lived presigned S3 URL. requests follows that redirect
# automatically; this header just makes the initial hop less likely to be
# treated as a bot.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def fetch_pdf(pdf_url: str) -> bytes:
    response = requests.get(
        pdf_url, headers={"User-Agent": BROWSER_USER_AGENT}, timeout=60
    )
    response.raise_for_status()
    if not response.content.startswith(b"%PDF-"):
        content_type = response.headers.get("content-type", "unknown")
        raise ValueError(
            f"URL did not return a PDF (content-type: {content_type}). "
            "The source may be blocking automated requests or the link may be broken."
        )
    return response.content
