import React from 'react';

import { createMap, resolve, SKIP, Routes, RouteMap } from './router';

describe('woozie router', () => {
  describe('SKIP symbol', () => {
    it('is a unique symbol', () => {
      expect(typeof SKIP).toBe('symbol');
      expect(SKIP.toString()).toBe('Symbol(Woozie.Router.Skip)');
    });
  });

  describe('createMap', () => {
    it('creates route map from routes', () => {
      const routes: Routes<{}> = [['/home', () => React.createElement('div', null, 'Home')]];

      const map = createMap(routes);

      expect(map).toHaveLength(1);
      expect(map[0]).toHaveProperty('route', '/home');
      expect(map[0]).toHaveProperty('resolveResult');
      expect(map[0]).toHaveProperty('pattern');
      expect(map[0]).toHaveProperty('keys');
      expect(map[0]!.pattern).toBeInstanceOf(RegExp);
    });

    it('creates map with multiple routes', () => {
      const routes: Routes<{}> = [
        ['/home', () => React.createElement('div', null, 'Home')],
        ['/about', () => React.createElement('div', null, 'About')],
        ['/user/:id', () => React.createElement('div', null, 'User')]
      ];

      const map = createMap(routes);

      expect(map).toHaveLength(3);
    });

    it('extracts keys from parameterized routes', () => {
      const routes: Routes<{}> = [['/user/:id', () => null]];

      const map = createMap(routes);

      expect(map[0]!.keys).toContain('id');
    });

    it('handles multiple parameters', () => {
      const routes: Routes<{}> = [['/user/:userId/post/:postId', () => null]];

      const map = createMap(routes);

      expect(map[0]!.keys).toContain('userId');
      expect(map[0]!.keys).toContain('postId');
    });
  });

  describe('resolve', () => {
    const homeComponent = React.createElement('div', null, 'Home');
    const aboutComponent = React.createElement('div', null, 'About');

    let routeMap: RouteMap<{}>;

    beforeEach(() => {
      const routes: Routes<{}> = [
        ['/home', () => homeComponent],
        ['/about', () => aboutComponent],
        ['/user/:id', params => React.createElement('div', null, `User ${params.id}`)]
      ];
      routeMap = createMap(routes);
    });

    it('resolves exact path match', () => {
      const result = resolve(routeMap, '/home', {});
      expect(result).toBe(homeComponent);
    });

    it('resolves parameterized route', () => {
      const result = resolve(routeMap, '/user/123', {});
      expect(result).not.toBeNull();
    });

    it('returns null for unmatched path', () => {
      const result = resolve(routeMap, '/nonexistent', {});
      expect(result).toBeNull();
    });

    it('passes params to resolver', () => {
      const resolver = jest.fn(() => React.createElement('div'));
      const routes: Routes<{}> = [['/item/:id', resolver]];
      const map = createMap(routes);

      resolve(map, '/item/456', {});

      expect(resolver).toHaveBeenCalledWith({ id: '456' }, {});
    });

    it('passes context to resolver', () => {
      const resolver = jest.fn(() => React.createElement('div'));
      const routes: Routes<{ user: string }> = [['/test', resolver]];
      const map = createMap(routes);
      const ctx = { user: 'testuser' };

      resolve(map, '/test', ctx);

      expect(resolver).toHaveBeenCalledWith({}, ctx);
    });

    it('skips route when resolver returns SKIP', () => {
      const routes: Routes<{}> = [
        ['/test', () => SKIP],
        ['/test', () => React.createElement('div', null, 'Fallback')]
      ];
      const map = createMap(routes);

      const result = resolve(map, '/test', {});
      expect(result).not.toBe(SKIP);
    });

    it('continues to next route on SKIP', () => {
      const fallbackComponent = React.createElement('div', null, 'Fallback');
      const routes: Routes<{}> = [
        ['/:path', params => (params.path === 'skip' ? SKIP : React.createElement('div'))],
        ['/:path', () => fallbackComponent]
      ];
      const map = createMap(routes);

      const result = resolve(map, '/skip', {});
      expect(result).toBe(fallbackComponent);
    });

    it('handles optional parameters', () => {
      const resolver = jest.fn(() => React.createElement('div'));
      const routes: Routes<{}> = [['/items/:id?', resolver]];
      const map = createMap(routes);

      resolve(map, '/items', {});
      expect(resolver).toHaveBeenCalled();

      resolver.mockClear();
      resolve(map, '/items/123', {});
      expect(resolver).toHaveBeenCalledWith({ id: '123' }, {});
    });
  });
});
