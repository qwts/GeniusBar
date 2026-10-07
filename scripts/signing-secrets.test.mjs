import assert from 'node:assert/strict';
import test from 'node:test';

import { SIGNING_SECRET_NAMES, WINDOWS_SIGNING_SECRET_NAMES, signingMode, windowsSigningMode } from './signing-secrets.mjs';

test('an empty signing environment is visibly unsigned', () => {
  assert.deepEqual(signingMode({}), { mode: 'unsigned-dev', signed: false });
});

test('all five signing secrets enable the production path', () => {
  const env = Object.fromEntries(SIGNING_SECRET_NAMES.map((name) => [name, `${name}-value`]));
  assert.deepEqual(signingMode(env), { mode: 'signed', signed: true });
});

test('every partial signing set fails closed without exposing values', () => {
  for (const omitted of SIGNING_SECRET_NAMES) {
    const env = Object.fromEntries(
      SIGNING_SECRET_NAMES.filter((name) => name !== omitted).map((name) => [name, 'sensitive']),
    );

    assert.throws(
      () => signingMode(env),
      (error) => error.message.includes(omitted) && !error.message.includes('sensitive'),
    );
  }
});

const azure = {
  AZURE_TENANT_ID: 'tenant',
  AZURE_CLIENT_ID: 'client',
  AZURE_CLIENT_SECRET: 'sensitive',
  AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
  AZURE_SIGNING_ACCOUNT: 'overlook-signing',
  AZURE_SIGNING_PROFILE: 'GeniusBar',
};

test('an empty Azure environment is a visibly unsigned Windows build with no sign command', () => {
  assert.deepEqual(windowsSigningMode({}), { mode: 'unsigned-dev', signed: false, config: {} });
  // The Apple secrets do not sign a Windows build, nor the Azure ones a Mac.
  const apple = Object.fromEntries(SIGNING_SECRET_NAMES.map((name) => [name, 'x']));
  assert.equal(windowsSigningMode(apple).signed, false);
  assert.equal(signingMode(azure).signed, false);
});

test('all six Azure secrets become the Trusted Signing sign command (ADR-0046 decision 8)', () => {
  const result = windowsSigningMode(azure);
  assert.equal(result.mode, 'signed');
  assert.equal(result.signed, true);
  assert.deepEqual(result.config, {
    bundle: {
      windows: {
        signCommand: 'artifact-signing-cli -e https://weu.codesigning.azure.net -a overlook-signing -c GeniusBar -d GeniusBar %1',
      },
    },
  });
  // The tenant, client and secret reach the CLI through its environment, never the command line.
  assert.equal(result.config.bundle.windows.signCommand.includes('sensitive'), false);
});

test('every partial Azure set fails closed without exposing values', () => {
  assert.equal(WINDOWS_SIGNING_SECRET_NAMES.length, 6);
  for (const omitted of WINDOWS_SIGNING_SECRET_NAMES) {
    const env = Object.fromEntries(
      WINDOWS_SIGNING_SECRET_NAMES.filter((name) => name !== omitted).map((name) => [name, 'sensitive']),
    );
    assert.throws(
      () => windowsSigningMode(env),
      (error) => error.message.includes(omitted) && error.message.includes('Azure') && !error.message.includes('sensitive'),
    );
  }
});

test('the endpoint, account and profile must have the shape a command line can carry', () => {
  assert.throws(() => windowsSigningMode({ ...azure, AZURE_SIGNING_ENDPOINT: 'weu.codesigning.azure.net' }), /not a URL/);
  assert.throws(() => windowsSigningMode({ ...azure, AZURE_SIGNING_ENDPOINT: 'http://weu.codesigning.azure.net' }), /https/);
  assert.throws(() => windowsSigningMode({ ...azure, AZURE_SIGNING_ACCOUNT: 'my account' }), /AZURE_SIGNING_ACCOUNT/);
  assert.throws(() => windowsSigningMode({ ...azure, AZURE_SIGNING_PROFILE: '-d evil' }), /AZURE_SIGNING_PROFILE/);
});
