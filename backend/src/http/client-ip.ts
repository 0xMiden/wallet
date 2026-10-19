import type { Request } from 'express';

import { HttpError } from './errors.js';

/** The IP of the caller, with the IPv4-mapped IPv6 prefix removed. Behind a proxy, set `trust proxy`. */
export function clientIp(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress;
  if (ip === undefined) {
    throw new HttpError(400, 'Client IP is not known');
  }
  return ip.replace(/^::ffff:/, '');
}
