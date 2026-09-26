// Accept SSE LF/CRLF, split UTF-8 chunks, data with or without one space,
// and the final event even when the connection ends without a blank line.
export async function* responseEvents(response) {
  if (!response.body) throw new Error("모델 응답 스트림이 없습니다.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const parse = (block) => {
    const data = block.split(/\r\n|\r|\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    return data && data !== "[DONE]" ? JSON.parse(data) : null;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parse(block);
        if (event) yield event;
      }
      if (done) {
        const event = parse(buffer);
        if (event) yield event;
        finished = true;
        break;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
