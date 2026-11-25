import { FEATURES, isFeature } from './constants';
import { ApiError } from './errors';
import { issueNonce, login } from './routes/auth';
import { healthz } from './routes/health';
import { deleteProfile, setSalt } from './routes/profile';
import { readEntry, readFeature, readStorage, writeBatch, writeEntry } from './routes/storage';
import type { Env, Feature, Handler } from './types';
import { parseHashedKey } from './validate';

const STORAGE_PATH = /^\/v1\/storage\/([^/]+)(?:\/([^/]+))?$/;

type Route =
  | { name: 'healthz' | 'nonce' | 'login' | 'salt' | 'profile' | 'storage' }
  | { name: 'feature'; feature: Feature }
  | { name: 'entry'; feature: Feature; hashedKey: string };

const ALLOWED_METHODS: Readonly<Record<Route['name'], string>> = {
  healthz: 'GET',
  nonce: 'POST',
  login: 'POST',
  salt: 'PUT',
  profile: 'DELETE',
  storage: 'GET',
  feature: 'GET, PUT',
  entry: 'GET, PUT'
};

function matchStorageRoute(pathname: string): Route {
  const match = STORAGE_PATH.exec(pathname);
  const feature = match?.[1];
  if (feature === undefined) throw new ApiError(404, 'not_found', 'The route does not exist.');
  if (!isFeature(feature)) {
    throw new ApiError(404, 'unknown_feature', `The feature must be one of: ${FEATURES.join(', ')}.`);
  }
  const hashedKey = match?.[2];
  if (hashedKey === undefined) return { name: 'feature', feature };
  return { name: 'entry', feature, hashedKey: parseHashedKey(hashedKey) };
}

function matchRoute(pathname: string): Route {
  switch (pathname) {
    case '/healthz':
      return { name: 'healthz' };
    case '/v1/auth/nonce':
      return { name: 'nonce' };
    case '/v1/auth/login':
      return { name: 'login' };
    case '/v1/profile/salt':
      return { name: 'salt' };
    case '/v1/profile':
      return { name: 'profile' };
    case '/v1/storage':
      return { name: 'storage' };
    default:
      return matchStorageRoute(pathname);
  }
}

/** Return the handler for a feature route and a method, or null. */
function featureHandler(method: string, feature: Feature): Handler | null {
  switch (method) {
    case 'GET':
      return context => readFeature(context, feature);
    case 'PUT':
      return context => writeBatch(context, feature);
    default:
      return null;
  }
}

/** Return the handler for an entry route and a method, or null. */
function entryHandler(method: string, feature: Feature, hashedKey: string): Handler | null {
  switch (method) {
    case 'GET':
      return context => readEntry(context, feature, hashedKey);
    case 'PUT':
      return context => writeEntry(context, feature, hashedKey);
    default:
      return null;
  }
}

/** Return the handler of a route with one method, or null for another method. */
function onlyFor(method: string, name: Route['name'], handler: Handler): Handler | null {
  return method === ALLOWED_METHODS[name] ? handler : null;
}

/** Return the handler for a route and a method, or null when the route refuses the method. */
function handlerFor(route: Route, method: string): Handler | null {
  switch (route.name) {
    case 'healthz':
      return onlyFor(method, route.name, healthz);
    case 'nonce':
      return onlyFor(method, route.name, issueNonce);
    case 'login':
      return onlyFor(method, route.name, login);
    case 'salt':
      return onlyFor(method, route.name, setSalt);
    case 'profile':
      return onlyFor(method, route.name, deleteProfile);
    case 'storage':
      return onlyFor(method, route.name, readStorage);
    case 'feature':
      return featureHandler(method, route.feature);
    case 'entry':
      return entryHandler(method, route.feature, route.hashedKey);
  }
}

/** Match the route, pick the handler for the method and run it. */
export async function dispatch(request: Request, env: Env, now: () => number): Promise<Response> {
  const url = new URL(request.url);
  const route = matchRoute(url.pathname);
  const handler = handlerFor(route, request.method);
  if (!handler) {
    const allow = ALLOWED_METHODS[route.name];
    throw new ApiError(405, 'bad_request', `The route allows only: ${allow}.`, {}, { Allow: allow });
  }
  return handler({ request, env, url, now });
}
