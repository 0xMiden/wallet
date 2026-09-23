/** @jest-environment node */

import React from 'react';

import { compile } from '@tailwindcss/node';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { ListGroup } from './ListGroup';
import { ListRow } from './ListRow';

// jsdom applies no CSS, so a class-presence test cannot tell whether the plain group's
// `[&>*]:` rules beat the rows' own padding and hairline inset. They tie on specificity
// (`.a>*` against `.b`, `.a>*::before` against `.b::before`), so the rule emitted later wins.
const escape = (candidate: string) => `.${candidate.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`)} {`;

it('a plain group puts every kind of row on the page margin with a full-width hairline', async () => {
  const markup = renderToStaticMarkup(
    React.createElement(ListGroup, {
      surface: 'plain',
      children: [
        React.createElement(ListRow, { key: 'none', title: 'Plain' }),
        React.createElement(ListRow, { key: 'icon', title: 'Icon', icon: React.createElement('svg') }),
        React.createElement(ListRow, { key: 'avatar', title: 'Avatar', avatar: React.createElement('span') })
      ]
    })
  );
  const [groupClasses, ...rowClasses] = [...markup.matchAll(/<(?:div|a|button|label) class="([^"]*)"/g)].map(m =>
    m[1]!.replace(/&gt;/g, '>').replace(/&amp;/g, '&').split(/\s+/)
  );
  expect(groupClasses).toEqual(expect.arrayContaining(['[&>*]:px-0', '[&>*]:before:left-0']));

  const rowInsets = ['before:left-4', 'before:left-[58px]', 'before:left-[68px]'];
  const candidates = [...new Set([...groupClasses!, ...rowClasses.flat()])];
  expect(candidates).toEqual(expect.arrayContaining(['px-4', ...rowInsets]));

  const compiler = await compile('@import "tailwindcss";', { base: path.resolve('src'), onDependency() {} });
  const css = compiler.build(candidates);
  const at = (candidate: string) => {
    const index = css.indexOf(escape(candidate));
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
  };

  expect(at('[&>*]:px-0')).toBeGreaterThan(at('px-4'));
  rowInsets.forEach(inset => expect(at('[&>*]:before:left-0')).toBeGreaterThan(at(inset)));
});
