import assert from 'node:assert/strict';
import test from 'node:test';

import { MANIFEST_PLATFORMS, WINDOWS_MANIFEST_PLATFORMS, updaterConfig, updaterManifest } from './updater.mjs';

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

test('the insecure flag opens http endpoints on unsigned builds only (#34)', () => {
  const local = {
    ...enabled,
    GENIUSBAR_UPDATER_ENDPOINT: 'http://localhost:8765/latest.json',
    GENIUSBAR_UPDATER_INSECURE: '1',
    TAURI_SIGNING_PRIVATE_KEY: 'throwaway-key',
  };
  const result = updaterConfig(local);
  assert.equal(result.enabled, true);
  assert.equal(result.artifacts, true);
  assert.equal(result.config.bundle.createUpdaterArtifacts, true);
  assert.equal(result.config.plugins.updater.dangerousInsecureTransportProtocol, true);
  // A signed build fails rather than ship an insecure updater.
  assert.throws(() => updaterConfig(local, { signed: true }), /unsigned local builds/);
  // Insecure artifacts still need a signing key, and http needs the flag.
  assert.throws(() => updaterConfig({ ...enabled, GENIUSBAR_UPDATER_INSECURE: '1' }), /TAURI_SIGNING_PRIVATE_KEY/);
  assert.throws(() => updaterConfig({ ...enabled, GENIUSBAR_UPDATER_ENDPOINT: 'http://x/latest.json' }), /https/);
});

test('the manifest allows an http archive only in insecure mode (#34)', () => {
  const url = 'http://localhost:8765/GeniusBar.app.tar.gz';
  assert.throws(() => updaterManifest({ version: '1.2.3', url, signature: 's' }), /https/);
  const manifest = updaterManifest({ version: '1.2.3', url, signature: 's' }, { insecure: true });
  assert.equal(manifest.platforms['darwin-aarch64'].url, url);
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

test('a signed Windows installer joins the manifest beside the darwin entries (ADR-0046 decision 8)', () => {
  const url = 'https://github.com/example/geniusbar/releases/download/v1.2.3/GeniusBar_1.2.3_universal.app.tar.gz';
  const installer = 'https://github.com/example/geniusbar/releases/download/v1.2.3/GeniusBar_1.2.3_x64_signed-setup.exe';
  const manifest = updaterManifest({ version: '1.2.3', url, signature: 'mac\n', windows: { url: installer, signature: 'win\n' } });
  assert.deepEqual(Object.keys(manifest.platforms), [...MANIFEST_PLATFORMS, ...WINDOWS_MANIFEST_PLATFORMS]);
  assert.deepEqual(manifest.platforms['windows-x86_64'], { signature: 'win', url: installer });
  assert.deepEqual(manifest.platforms['darwin-aarch64'], { signature: 'mac', url });
  // Without a signed Windows build the manifest is the macOS one, so a Windows install sees no update.
  const macOnly = updaterManifest({ version: '1.2.3', url, signature: 'mac' });
  assert.deepEqual(Object.keys(macOnly.platforms), MANIFEST_PLATFORMS);
  // The Windows entry is checked like the macOS one.
  assert.throws(() => updaterManifest({ version: '1.2.3', url, signature: 's', windows: { url: 'http://x/setup.exe', signature: 's' } }), /https/);
  assert.throws(() => updaterManifest({ version: '1.2.3', url, signature: 's', windows: { url: installer, signature: ' ' } }), /Windows update signature/);
});
