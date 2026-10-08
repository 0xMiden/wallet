import type { RequestHandler } from 'express';

import type { Config } from '../config.js';

export function cors(allowedOrigins: Config['allowedOrigins']): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      res.setHeader('Vary', 'Origin');
      if (origin !== undefined && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}
