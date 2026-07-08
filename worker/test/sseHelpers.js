export function fakeSSEResponse(dataLines, { ok = true, status = 200 } = {}) {
  const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  return {
    ok,
    status,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
  };
}
