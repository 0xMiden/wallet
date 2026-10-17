/* eslint-disable import/first */
import fs from 'fs';
import path from 'path';

jest.mock('@capacitor/app', () => ({ App: {} }));

import { OPEN_LINK_HOST, parseOpenLink } from './open-link';

/**
 * An open link reaches Bread only while the app's native declarations, the files the link host serves and
 * the parser agree. A mismatch fails silently on a device: the link just opens the web page instead.
 */

const read = (relative: string) => fs.readFileSync(path.join(__dirname, '../../..', relative), 'utf8');
const captures = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].flatMap(match => match[1] ?? []);

const PAGE = 'https://app.example.com/';
const QUERY = `?url=${encodeURIComponent(PAGE)}`;

const manifest = read('android/app/src/main/AndroidManifest.xml');
const verifiedFilters = captures(manifest, /<intent-filter android:autoVerify="true">([\s\S]*?)<\/intent-filter>/g);

describe('open link declarations', () => {
  it('has iOS claim exactly the link host', () => {
    const entitlements = read('ios/App/App/App.entitlements');

    expect(captures(entitlements, /<string>applinks:([^<]+)<\/string>/g)).toEqual([OPEN_LINK_HOST]);
  });

  it('has Android verify exactly the link host and path', () => {
    expect(verifiedFilters).toHaveLength(1);
    const [filter = ''] = verifiedFilters;
    expect(captures(filter, /android:scheme="([^"]+)"/g)).toEqual(['https']);
    expect(captures(filter, /android:host="([^"]+)"/g)).toEqual([OPEN_LINK_HOST]);
    expect(captures(filter, /android:path="([^"]+)"/g)).toEqual(['/open']);
  });

  it('parses links at the link host and at every custom scheme the apps declare', () => {
    const plistSchemes = captures(
      read('ios/App/App/Info.plist'),
      /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g
    ).flatMap(array => captures(array, /<string>([^<]+)<\/string>/g));
    const manifestSchemes = captures(manifest, /android:scheme="([^"]+)"/g).filter(scheme => scheme !== 'https');
    const schemes = [...new Set([...plistSchemes, ...manifestSchemes])];

    expect(schemes).not.toHaveLength(0);
    expect(parseOpenLink(`https://${OPEN_LINK_HOST}/open${QUERY}`)).toBe(PAGE);
    for (const scheme of schemes) expect(parseOpenLink(`${scheme}://open${QUERY}`)).toBe(PAGE);
  });

  it('serves an Apple association file naming the iOS app and the open path', () => {
    const project = read('ios/App/App.xcodeproj/project.pbxproj');
    const teams = new Set(captures(project, /DEVELOPMENT_TEAM = (\w+);/g));
    const bundleIds = new Set(
      captures(project, /PRODUCT_BUNDLE_IDENTIFIER = ([\w.]+);/g).filter(id => !id.endsWith('.tests'))
    );
    expect(teams.size).toBe(1);
    expect(bundleIds.size).toBe(1);
    const appId = `${[...teams][0]}.${[...bundleIds][0]}`;

    const association = JSON.parse(read('docs/.well-known/apple-app-site-association'));

    expect(association.applinks.details).toEqual([
      expect.objectContaining({ appIDs: [appId], components: [expect.objectContaining({ '/': '/open' })] })
    ]);
  });

  it('serves an asset links file naming the Android app and at least one signing certificate', () => {
    const [applicationId] = captures(read('android/app/build.gradle'), /applicationId "([^"]+)"/g);

    const assetLinks = JSON.parse(read('docs/.well-known/assetlinks.json'));

    expect(assetLinks).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: applicationId,
          sha256_cert_fingerprints: expect.arrayContaining([expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)])
        }
      }
    ]);
  });

  it('has the Pages build publish the association files, which Jekyll skips as a dot-directory', () => {
    expect(read('docs/_config.yml')).toMatch(/^include:\n {2}- \.well-known$/m);
  });
});
