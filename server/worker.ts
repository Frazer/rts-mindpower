/**
 * The online relay on Cloudflare: `npm run relay:deploy`. The game rooms are in rooms.ts.
 *
 * One Durable Object holds every room. It's awake (and counted against the free plan's
 * daily limit) while anyone is connected, but one object can't use more than a day's
 * worth of that limit however many rooms it holds. It would if each room had its own.
 */
import { DurableObject } from 'cloudflare:workers';
import { createRelay, MAX_MESSAGE } from './rooms.ts';

interface Env {
  RELAY: DurableObjectNamespace<RelayObject>;
}

export class RelayObject extends DurableObject<Env> {
  private readonly relay = createRelay();

  async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const session = this.relay.open({
      send: (text) => {
        // Throws if the connection has just gone; its close event deals with that.
        try {
          server.send(text);
        } catch {}
      },
      close: () => {
        try {
          server.close();
        } catch {}
      },
    });
    server.addEventListener('message', (e) => {
      if (typeof e.data === 'string' && e.data.length <= MAX_MESSAGE) this.relay.message(session, e.data);
    });
    server.addEventListener('close', () => this.relay.closed(session));
    server.addEventListener('error', () => this.relay.closed(session));
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  fetch(req, env) {
    if (new URL(req.url).pathname !== '/relay') return new Response('Mind Blobs relay\n');
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket\n', { status: 426 });
    return env.RELAY.get(env.RELAY.idFromName('main')).fetch(req);
  },
} satisfies ExportedHandler<Env>;
