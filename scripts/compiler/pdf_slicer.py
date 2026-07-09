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
