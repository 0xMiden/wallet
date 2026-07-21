import axios from 'axios';

import makeBuildQueryFn from './makeBuildQueryFn';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('makeBuildQueryFn', () => {
  let request: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    request = jest.fn().mockResolvedValue({ data: { ok: true } });
    (mockedAxios.create as jest.Mock).mockReturnValue({ request } as any);
  });

  it('creates the axios instance with the provided baseURL', () => {
    makeBuildQueryFn('https://api.example.com');
    expect(mockedAxios.create).toHaveBeenCalledWith({ baseURL: 'https://api.example.com' });
  });

  it('string path + no toQueryParams sends params: undefined and returns r.data', async () => {
    const build = makeBuildQueryFn<{ id: number }, { ok: boolean }>('https://api.example.com');
    const query = build('GET', '/users');

    const result = await query({ id: 1 });

    expect(request).toHaveBeenCalledWith({ method: 'GET', url: '/users', params: undefined });
    expect(result).toEqual({ ok: true });
  });

  it('function path builds the url from params', async () => {
    const build = makeBuildQueryFn<{ id: number }, unknown>('https://api.example.com');
    const query = build('GET', (p: { id: number }) => `/users/${p.id}`);

    await query({ id: 42 });

    expect(request).toHaveBeenCalledWith({ method: 'GET', url: '/users/42', params: undefined });
  });

  it('array toQueryParams picks only present keys and skips absent ones', async () => {
    request.mockResolvedValueOnce({ data: [1, 2, 3] });
    // `id` is present in the params object, `missing` is not — exercises both
    // branches of `key in obj` inside `pick`.
    const build = makeBuildQueryFn<{ id: number; extra: string }, number[]>('https://api.example.com');
    const query = build('POST', (p: { id: number }) => `/users/${p.id}`, ['id', 'missing' as any]);

    const result = await query({ id: 7, extra: 'x' });

    expect(request).toHaveBeenCalledWith({ method: 'POST', url: '/users/7', params: { id: 7 } });
    expect(result).toEqual([1, 2, 3]);
  });

  it('function toQueryParams computes the query params from params', async () => {
    const build = makeBuildQueryFn<{ q: string }, unknown>('https://api.example.com');
    const query = build('GET', '/search', (p: { q: string }) => ({ query: p.q, page: 1 }));

    await query({ q: 'abc' });

    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/search',
      params: { query: 'abc', page: 1 }
    });
  });

  it('propagates rejections from the underlying request', async () => {
    request.mockRejectedValueOnce(new Error('network down'));
    const build = makeBuildQueryFn<{ id: number }, unknown>('https://api.example.com');
    const query = build('GET', '/users');

    await expect(query({ id: 1 })).rejects.toThrow('network down');
  });
});
