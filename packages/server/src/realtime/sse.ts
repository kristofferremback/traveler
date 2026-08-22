import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { logger } from "../lib/log.ts";

const log = logger("sse");

/** Proxies and mobile radios drop a silent connection; this keeps it warm. */
const HEARTBEAT_MS = 25_000;

export type Emitter<T> = (
  push: (event: string, data: unknown) => void,
) => () => void;

/**
 * Bridge a hub subscription onto an SSE response.
 *
 * Server-sent events rather than websockets: every stream here is one-directional and
 * server-driven, and SSE reconnects on its own, survives HTTP/2 and proxies without
 * an upgrade handshake, and needs no keep-alive protocol of its own. A websocket would
 * add a second transport to maintain for no capability we use.
 */
/**
 * Named `stream-error`, not `error`.
 *
 * An SSE frame with `event: error` is dispatched on the EventSource as an event named
 * "error", which is the same name the transport uses for connection failures. A genuine
 * upstream message would land in `onerror` and be indistinguishable from the socket
 * dropping, so the payload gets its own name.
 */
export const ERROR_EVENT = "stream-error";

export function sseStream<T>(c: Context, name: string, attach: Emitter<T>) {
  return streamSSE(c, async (stream) => {
    let id = 0;
    let closed = false;

    const push = (event: string, data: unknown) => {
      if (closed) return;
      void stream
        .writeSSE({ event, data: JSON.stringify(data), id: String(++id) })
        .catch(() => {
          // The client hung up between the check and the write. Nothing to do; the
          // abort handler below performs the actual teardown.
        });
    };

    const detach = attach(push);
    log.debug(`${name}: client connected`);

    const heartbeat = setInterval(() => {
      if (!closed) void stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
    }, HEARTBEAT_MS);

    const teardown = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      detach();
      log.debug(`${name}: client disconnected`);
    };

    stream.onAbort(teardown);

    // Hold the response open until the client goes away. Resolving early would close
    // the stream and turn every subscription into a single delivered event.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        teardown();
        resolve();
      });
    });
  });
}
