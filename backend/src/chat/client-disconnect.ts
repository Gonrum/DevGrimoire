/**
 * Detecting that the client of a streaming (SSE) response has gone away.
 *
 * Not `req.on('close')`: for a POST, Node emits the request's 'close' as soon
 * as the body has been read — Express' body parser has done that before the
 * handler runs, so a listener attached in the handler never fires. The
 * response's 'close' fires when the connection ends; if that happens before our
 * own `res.end()` (`writableEnded` still false), the client left.
 */
export interface DisconnectAware {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  on(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
}

/**
 * Calls `onGone` once the client disconnects — immediately if it already has
 * (the 'close' event of a connection lost during an earlier `await` is not
 * replayed). Returns the function that removes the listener.
 */
export function onClientDisconnect(res: DisconnectAware, onGone: () => void): () => void {
  const listener = () => {
    if (!res.writableEnded) onGone();
  };
  res.on('close', listener);
  if (res.destroyed && !res.writableEnded) onGone();
  return () => {
    res.off('close', listener);
  };
}
