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

export async function readAllText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}
