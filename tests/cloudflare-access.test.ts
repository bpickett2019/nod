import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';
import { cloudflareAccessIdentity } from '../src/server/cloudflare-access.ts';

const team = 'example.cloudflareaccess.com';
const audience = 'a'.repeat(64);
const signer = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certs = {
  keys: [{ ...signer.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }],
};
const fetcher = (async () => new Response(JSON.stringify(certs))) as typeof fetch;

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const assertion = (claims: object, key = signer.privateKey) => {
  const body = `${part({ alg: 'RS256', kid: 'k1' })}.${part(claims)}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
};
const claims = (overrides: object = {}) => ({
  iss: `https://${team}`,
  aud: [audience],
  email: 'Owner@Example.com',
  exp: Date.now() / 1000 + 600,
  ...overrides,
});
const request = (value?: string) =>
  ({ headers: value ? { 'cf-access-jwt-assertion': value } : {} }) as FastifyRequest;

test('only a Cloudflare Access sign-in for an allowed email is accepted', async () => {
  const identity = cloudflareAccessIdentity(
    { team, audience, emails: ['owner@example.com', 'admin@example.com'] },
    fetcher,
  );
  assert.equal(await identity(request(assertion(claims()))), true);
  assert.equal(await identity(request(assertion(claims({ email: 'admin@example.com' })))), true);
  assert.equal(await identity(request()), false);
  assert.equal(await identity(request(assertion(claims(), stranger.privateKey))), false);
  assert.equal(
    await identity(request(assertion(claims({ email: 'coworker@example.com' })))),
    false,
  );
  assert.equal(await identity(request(assertion(claims({ aud: ['b'.repeat(64)] })))), false);
  assert.equal(
    await identity(request(assertion(claims({ iss: 'https://other.cloudflareaccess.com' })))),
    false,
  );
  assert.equal(await identity(request(assertion(claims({ exp: Date.now() / 1000 - 1 })))), false);
});
