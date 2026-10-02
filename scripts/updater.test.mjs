import assert from 'node:assert/strict';
import test from 'node:test';

import { MANIFEST_PLATFORMS, updaterConfig, updaterManifest } from './updater.mjs';

const b64 = (text) => Buffer.from(text).toString('base64');
const PUBKEY = b64('untrusted comment: minisign public key: D51590362A882FEF\nRWTvL4gqNpAV1d4olkJEv7sxQuSTQ7uQFh0jwYWCBz1g33WnwOpnmbxO\n');
const ENDPOINT = 'https://github.com/example/geniusbar/releases/latest/download/latest.json';
const enabled = { GENIUSBAR_UPDATER_PUBKEY: PUBKEY, GENIUSBAR_UPDATER_ENDPOINT: ENDPOINT };

test('no updater variables build an app with the updater off', () => {
  assert.deepEqual(updaterConfig({}), { enabled: false, artifacts: false, config: {} });
  assert.deepEqual(updaterConfig({}, { signed: true }), { enabled: false, artifacts: false, config: {} });
});

test('a partial updater configuration fails', () => {
  assert.throws(() => updaterConfig({ GENIUSBAR_UPDATER_PUBKEY: PUBKEY }), /missing: GENIUSBAR_UPDATER_ENDPOINT/);
  assert.throws(() => updaterConfig({ GENIUSBAR_UPDATER_ENDPOINT: ENDPOINT }), /missing: GENIUSBAR_UPDATER_PUBKEY/);
});

test('the key and endpoint reach the app as plugin configuration', () => {
  const result = updaterConfig(enabled);
  assert.equal(result.enabled, true);
  assert.deepEqual(result.config.plugins.updater, { pubkey: PUBKEY, endpoints: [ENDPOINT] });
});

test('only a signed build produces updater artifacts', () => {
  assert.equal(updaterConfig(enabled).artifacts, false);
  assert.equal(updaterConfig(enabled).config.bundle.createUpdaterArtifacts, false);
  const signed = updaterConfig({ ...enabled, TAURI_SIGNING_PRIVATE_KEY: 'key' }, { signed: true });
  assert.equal(signed.artifacts, true);
  assert.equal(signed.config.bundle.createUpdaterArtifacts, true);
});

test('a signed updater build without the updater key fails without echoing values', () => {
  assert.throws(
    () => updaterConfig(enabled, { signed: true }),
    (error) => error.message.includes('TAURI_SIGNING_PRIVATE_KEY') && !error.message.includes(PUBKEY),
  );
});

test('the updater refuses a private key, a non-key, and plain HTTP', () => {
  const secret = b64('untrusted comment: rsign encrypted secret key\nRWRTY0Iy...\n');
  assert.throws(() => updaterConfig({ ...enabled, GENIUSBAR_UPDATER_PUBKEY: secret }), /not a Tauri updater public key/);
  assert.throws(() => updaterConfig({ ...enabled, GENIUSBAR_UPDATER_PUBKEY: 'hello' }), /not a Tauri updater public key/);
  assert.throws(() => updaterConfig({ ...enabled, GENIUSBAR_UPDATER_ENDPOINT: 'http://example.com/latest.json' }), /https/);
  assert.throws(() => updaterConfig({ ...enabled, GENIUSBAR_UPDATER_ENDPOINT: 'latest.json' }), /not a URL/);
});

test('the manifest serves the universal archive to both architectures', () => {
  const url = 'https://github.com/example/geniusbar/releases/download/v1.2.3/GeniusBar_1.2.3_universal.app.tar.gz';
  const manifest = updaterManifest({ version: '1.2.3', url, signature: 'c2ln\n', pubDate: new Date(0) });
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.pub_date, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(manifest.platforms), MANIFEST_PLATFORMS);
  for (const entry of Object.values(manifest.platforms)) assert.deepEqual(entry, { signature: 'c2ln', url });
});

test('the manifest rejects a bad version, URL, or empty signature', () => {
  const url = 'https://example.com/a.tar.gz';
  assert.throws(() => updaterManifest({ version: 'v1.2.3', url, signature: 's' }), /semver/);
  assert.throws(() => updaterManifest({ version: '1.2.3', url: 'http://example.com/a', signature: 's' }), /https/);
  assert.throws(() => updaterManifest({ version: '1.2.3', url, signature: ' \n' }), /signature/);
});
