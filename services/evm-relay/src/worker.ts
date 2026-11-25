// The Wrangler entry: the fetch handler and the Durable Object class. index.ts stays free of `cloudflare:workers`,
// so the Jest tests can load the handler.
export { default } from './index';
export { RelaySenderObject } from './sender-object';
