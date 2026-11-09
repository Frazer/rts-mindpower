import { ALIVE_SEC, type ClientMsg, type ServerMsg } from './protocol';

/** Where the online relay lives: set VITE_RELAY_URL for a real build; `npm run dev` serves one itself. */
export function relayUrl(): string | null {
  const env = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (env) return env;
  if (import.meta.env.DEV) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`;
  return null;
}

/** One WebSocket to the relay. */
export class Connection {
  onMsg: (m: ServerMsg) => void = () => {};
  onClose: () => void = () => {};
  private closedByUs = false;

  private constructor(private readonly ws: WebSocket) {
    const alive = setInterval(() => this.send({ t: 'alive' }), ALIVE_SEC * 1000);
    ws.addEventListener('message', (e) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      this.onMsg(m);
    });
    ws.addEventListener('close', () => {
      clearInterval(alive);
      if (!this.closedByUs) this.onClose();
    });
  }

  static open(url: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const fail = (): void => reject(new Error('Could not reach the game server.'));
      ws.addEventListener('error', fail, { once: true });
      ws.addEventListener(
        'open',
        () => {
          ws.removeEventListener('error', fail);
          resolve(new Connection(ws));
        },
        { once: true },
      );
    });
  }

  send(m: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.closedByUs = true;
    this.ws.close();
  }
}
