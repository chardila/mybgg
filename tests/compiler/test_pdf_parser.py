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
