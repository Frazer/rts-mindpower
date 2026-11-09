/** Stand-alone relay for hosting online play: `node server/main.ts` (PORT defaults to 8787). */
import { createServer } from 'node:http';
import { attachRelay } from './relay.ts';

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Mind Blobs relay\n');
});
attachRelay(server, '/relay');
const port = Number(process.env.PORT) || 8787;
server.listen(port, () => console.log(`Mind Blobs relay on :${port}/relay`));
