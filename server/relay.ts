/** The online relay on Node: used by `npm run dev` and `npm run relay`. The game rooms are in rooms.ts. */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { createRelay, MAX_MESSAGE } from './rooms.ts';

/** Serve the relay on `path` of an existing HTTP server (the Vite dev server, or a small Node one). */
export function attachRelay(server: Server, path = '/relay'): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  const relay = createRelay();
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const s = relay.open({
        send: (text) => {
          if (ws.readyState === ws.OPEN) ws.send(text);
        },
        close: () => ws.close(),
      });
      ws.on('message', (raw) => relay.message(s, String(raw)));
      ws.on('close', () => relay.closed(s));
      ws.on('error', () => ws.terminate());
    });
  });
  return wss;
}
