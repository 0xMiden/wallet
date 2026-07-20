import { AxiosInstance } from 'axios';

import { buildQuery } from './build-query';

/**
 * Build a minimal fake `AxiosInstance` whose `request` records its config and
 * resolves to a fixed `{ data }` envelope, mirroring how axios returns.
 */
function makeApi(data: unknown = { ok: true }) {
  const request = jest.fn().mockResolvedValue({ data });
  return { api: { request } as unknown as AxiosInstance, request };
}

describe('buildQuery', () => {
  it('resolves a string path, sends no query params, and unwraps response.data', async () => {
    const { api, request } = makeApi({ value: 42 });

    const query = buildQuery<{ id: string }>(api, 'GET', '/static/path');
    const result = await query({ id: 'abc' });

    expect(result).toEqual({ value: 42 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/static/path',
      params: undefined,
      // domain params are spread into the request config as-is
      id: 'abc'
    });
  });

  it('computes the url from a path function using the request params', async () => {
    const { api, request } = makeApi();

    const query = buildQuery<{ id: string }>(api, 'POST', params => `/users/${params.id}`);
    await query({ id: 'user-7' });

    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/users/user-7',
      params: undefined,
      id: 'user-7'
    });
  });

  it('derives query params from a toQueryParams function', async () => {
    const { api, request } = makeApi();

    const toQueryParams = jest.fn((params: { id: string; page: number }) => ({
      q: params.id,
      page: params.page
    }));
    const query = buildQuery<{ id: string; page: number }>(api, 'GET', '/search', toQueryParams);
    await query({ id: 'x', page: 2 });

    expect(toQueryParams).toHaveBeenCalledWith({ id: 'x', page: 2 });
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/search',
      params: { q: 'x', page: 2 },
      id: 'x',
      page: 2
    });
  });

  it('picks the listed keys as query params, ignoring keys absent from params', async () => {
    const { api, request } = makeApi();

    // 'currency' exists (included), 'missing' is absent (skipped by `key in obj`)
    const query = buildQuery<{ currency: string; missing?: string; other: number }>(api, 'GET', '/rates', [
      'currency',
      'missing'
    ]);
    await query({ currency: 'usd', other: 99 });

    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/rates',
      params: { currency: 'usd' },
      currency: 'usd',
      other: 99
    });
    // the absent key must not appear even as undefined
    expect(request.mock.calls[0][0].params).not.toHaveProperty('missing');
  });

  it('includes a listed key even when its value is undefined, as long as it is present', async () => {
    const { api, request } = makeApi();

    const query = buildQuery<{ token: string | undefined }>(api, 'GET', '/x', ['token']);
    await query({ token: undefined });

    // `token` is a present own-property, so `key in obj` is true and it is picked
    expect(request.mock.calls[0][0].params).toEqual({ token: undefined });
    expect(request.mock.calls[0][0].params).toHaveProperty('token');
  });

  it('combines a path function with a key-array selector', async () => {
    const { api, request } = makeApi({ id: 'z' });

    const query = buildQuery<{ id: string; verbose: boolean }>(api, 'GET', params => `/items/${params.id}`, [
      'verbose'
    ]);
    const data = await query({ id: 'z', verbose: true });

    expect(data).toEqual({ id: 'z' });
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/items/z',
      params: { verbose: true },
      id: 'z',
      verbose: true
    });
  });

  it('propagates rejections from the underlying api.request', async () => {
    const { api, request } = makeApi();
    const boom = new Error('network down');
    request.mockRejectedValueOnce(boom);

    const query = buildQuery<{ id: string }>(api, 'GET', '/fail');

    await expect(query({ id: '1' })).rejects.toThrow('network down');
  });

  it('lets caller-supplied axios config on params override the request config via spread', async () => {
    const { api, request } = makeApi();

    const query = buildQuery<{ id: string }>(api, 'GET', '/cfg');
    await query({ id: '1', headers: { Authorization: 'Bearer t' }, timeout: 5000 });

    const sentConfig = request.mock.calls[0][0];
    expect(sentConfig.headers).toEqual({ Authorization: 'Bearer t' });
    expect(sentConfig.timeout).toBe(5000);
    expect(sentConfig.method).toBe('GET');
    expect(sentConfig.url).toBe('/cfg');
  });
});
