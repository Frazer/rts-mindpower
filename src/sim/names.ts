import type { Rng } from './rng';

const HEAD = ['Bo', 'Pi', 'Lu', 'Mo', 'Zu', 'Ki', 'Ta', 'Ne', 'Fi', 'Gu', 'Wo', 'Bi', 'Mi', 'Pu', 'Lo', 'Ju', 'Ri', 'Sa', 'Do', 'Ya'];
const TAIL = ['b', 'p', 'ppy', 'mo', 'lo', 'nk', 'zz', 'bo', 'li', 'mi', 'ro', 'tt', 'sh', 'na', 'do', 'gle', 'bble', 'x'];

export function blobName(rng: Rng): string {
  let name = rng.pick(HEAD) + rng.pick(TAIL);
  if (rng.chance(0.2)) name += rng.pick(HEAD).toLowerCase();
  return name;
}
