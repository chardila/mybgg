import io
from pypdf import PdfReader, PdfWriter


def slice_pages(pdf_bytes: bytes, page_ranges: list[tuple[int, int]]) -> bytes:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    num_pages = len(reader.pages)
    writer = PdfWriter()
    for start, end in page_ranges:
        clamped_start = max(start, 1)
        clamped_end = min(end, num_pages)
        if clamped_start > num_pages or clamped_start > clamped_end:
            continue
        for page_index in range(clamped_start - 1, clamped_end):
            writer.add_page(reader.pages[page_index])
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()
