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
