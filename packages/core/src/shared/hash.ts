import { createHash } from 'node:crypto';

export function sha1(data: string | Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

export function sha1Text(value: string): string {
  return sha1(value);
}
