/* eslint-disable import/first */
import fs from 'fs';
import path from 'path';

import { BREAD_REQUEST_URL } from '@miden-sdk/bread-connect';

jest.mock('@capacitor/app', () => ({ App: {} }));

import { OPEN_LINK_HOST, parseOpenLink } from './open-link';

/**
 * An open link reaches Bread only while the app's native declarations, the parser and the files
 * 0xMiden/wallet-link serves at the link host agree. A mismatch fails silently on a device: the link just
 * opens the web page instead. These cases pin this repository's half; the app ID and package the last case
 * names stand for what 0xMiden/wallet-link's files declare.
 */

const read = (relative: string) => fs.readFileSync(path.join(__dirname, '../../..', relative), 'utf8');
const captures = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].flatMap(match => match[1] ?? []);

const PAGE = 'https://app.example.com/';
const PARAMS = `url=${encodeURIComponent(PAGE)}`;

const manifest = read('android/app/src/main/AndroidManifest.xml');
const verifiedFilters = captures(manifest, /<intent-filter android:autoVerify="true">([\s\S]*?)<\/intent-filter>/g);
// A scheme link's host is "open", so a filter limited to another host, like the sign-in callback's, never takes one.
const schemeFilters = captures(manifest, /<intent-filter>([\s\S]*?)<\/intent-filter>/g).filter(
  filter =>
    filter.includes('android:scheme=') && captures(filter, /android:host="([^"]+)"/g).every(host => host === 'open')
);

describe('open link declarations', () => {
  it('has iOS claim exactly the link host', () => {
    const entitlements = read('ios/App/App/App.entitlements');

    expect(captures(entitlements, /<string>applinks:([^<]+)<\/string>/g)).toEqual([OPEN_LINK_HOST]);
  });

  it("has Android verify exactly the link host's open and Bread Connect request paths", () => {
    const request = new URL(BREAD_REQUEST_URL);
    expect(request.host).toBe(OPEN_LINK_HOST);
    expect(verifiedFilters).toHaveLength(1);
    const [filter = ''] = verifiedFilters;
    expect(captures(filter, /android:scheme="([^"]+)"/g)).toEqual(['https', 'https']);
    expect(captures(filter, /android:host="([^"]+)"/g)).toEqual([OPEN_LINK_HOST, OPEN_LINK_HOST]);
    expect(captures(filter, /android:path="([^"]+)"/g)).toEqual(['/open', request.pathname]);
  });

  it('has both Android link filters take the link a browser hands over', () => {
    expect(verifiedFilters).toHaveLength(1);
    expect(schemeFilters).toHaveLength(1);
    for (const filter of [...verifiedFilters, ...schemeFilters]) {
      expect(captures(filter, /<action android:name="([^"]+)"/g)).toEqual(['android.intent.action.VIEW']);
      expect(captures(filter, /<category android:name="([^"]+)"/g).sort()).toEqual([
        'android.intent.category.BROWSABLE',
        'android.intent.category.DEFAULT'
      ]);
    }
  });

  // Bread opens a Bread Connect answer only in an app whose certificate the callback domain's assetlinks.json names,
  // and from Android 11 it can read another app's certificate only for an app its queries make visible.
  it('lets Android show Bread every app that takes https links', () => {
    const intents = captures(manifest, /<queries>([\s\S]*?)<\/queries>/g).flatMap(queries =>
      captures(queries, /<intent>([\s\S]*?)<\/intent>/g)
    );

    expect(
      intents.map(intent => ({
        actions: captures(intent, /<action android:name="([^"]+)"/g),
        categories: captures(intent, /<category android:name="([^"]+)"/g),
        schemes: captures(intent, /android:scheme="([^"]+)"/g)
      }))
    ).toContainEqual({
      actions: ['android.intent.action.VIEW'],
      categories: ['android.intent.category.BROWSABLE'],
      schemes: ['https']
    });
  });

  it('parses links at the link host and at every custom scheme the apps declare', () => {
    const plistSchemes = captures(
      read('ios/App/App/Info.plist'),
      /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g
    ).flatMap(array => captures(array, /<string>([^<]+)<\/string>/g));
    const manifestSchemes = schemeFilters.flatMap(filter => captures(filter, /android:scheme="([^"]+)"/g));
    const schemes = [...new Set([...plistSchemes, ...manifestSchemes])];

    expect(schemes).not.toHaveLength(0);
    expect(parseOpenLink(`https://${OPEN_LINK_HOST}/open#${PARAMS}`)).toBe(PAGE);
    for (const scheme of schemes) expect(parseOpenLink(`${scheme}://open?${PARAMS}`)).toBe(PAGE);
  });

  // 0xMiden/wallet-link's association files name this app ID and package: changing either here needs a change there.
  it('keeps the app ID and package 0xMiden/wallet-link names', () => {
    const project = read('ios/App/App.xcodeproj/project.pbxproj');
    const teams = new Set(captures(project, /DEVELOPMENT_TEAM = (\w+);/g));
    const bundleIds = new Set(
      captures(project, /PRODUCT_BUNDLE_IDENTIFIER = ([\w.]+);/g).filter(id => !id.endsWith('.tests'))
    );

    expect([...teams].flatMap(team => [...bundleIds].map(id => `${team}.${id}`))).toEqual([
      'LHU7B7J5WL.com.miden.bread'
    ]);
    expect(captures(read('android/app/build.gradle'), /applicationId "([^"]+)"/g)).toEqual(['com.miden.wallet']);
  });
});
