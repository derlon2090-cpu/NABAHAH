const encoder = new TextEncoder();

export type SSEEventName =
  | "metadata"
  | "section_start"
  | "text_delta"
  | "formula"
  | "citation"
  | "completed"
  | "error";

export class SSEWriter {
  #controller: ReadableStreamDefaultController<Uint8Array>;
  #closed = false;

  constructor(controller: ReadableStreamDefaultController<Uint8Array>) {
    this.#controller = controller;
    this.#controller.enqueue(encoder.encode(": connected\n\n"));
  }

  emit(event: SSEEventName, data: Record<string, unknown>) {
    if (this.#closed) return;
    this.#controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.close();
  }
}

export function sseResponse(
  producer: (writer: SSEWriter) => Promise<void>,
  signal?: AbortSignal,
  allowedOrigin = "*",
) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const writer = new SSEWriter(controller);
      const abort = () => writer.close();
      signal?.addEventListener("abort", abort, { once: true });
      void producer(writer)
        .catch(() => writer.emit("error", { error: "stream_failed" }))
        .finally(() => {
          signal?.removeEventListener("abort", abort);
          writer.close();
        });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "access-control-allow-origin": allowedOrigin,
      "access-control-allow-headers": "authorization,content-type",
    },
  });
}
