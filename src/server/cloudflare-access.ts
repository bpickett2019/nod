import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export type CloudflareAccess = { team: string; audience: string; emails: string[] };

export function cloudflareAccessSettings(env: NodeJS.ProcessEnv): CloudflareAccess | undefined {
  const team = env.NOD_CLOUDFLARE_ACCESS_TEAM;
  const audience = env.NOD_CLOUDFLARE_ACCESS_AUD;
  const email = env.NOD_CLOUDFLARE_ACCESS_EMAIL;
  const emails = (email ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!team && !audience && !email) return undefined;
  if (!team || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team))
    throw new Error(
      'Set NOD_CLOUDFLARE_ACCESS_TEAM to your team domain, such as example.cloudflareaccess.com.',
    );
  if (!audience || !/^[a-f0-9]{64}$/.test(audience))
    throw new Error(
      'Set NOD_CLOUDFLARE_ACCESS_AUD to the application audience tag from Cloudflare Access.',
    );
  if (!emails.length || emails.some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))
    throw new Error(
      'Set NOD_CLOUDFLARE_ACCESS_EMAIL to the email addresses allowed into this Nod, separated by commas.',
    );
  return { team, audience, emails };
}

export function cloudflareAccessIdentity(
  settings: CloudflareAccess,
  fetcher: typeof fetch = fetch,
) {
  const issuer = `https://${settings.team}`;
  let keys = new Map<string, KeyObject>();
  let loadedAt = 0;
  let loading: Promise<void> | undefined;
  const load = async () => {
    const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Cloudflare Access keys are unavailable.');
    const body = (await response.json()) as { keys?: JsonWebKey[] };
    keys = new Map(
      (body.keys ?? [])
        .filter((key) => key.kty === 'RSA' && typeof key.kid === 'string')
        .map((key) => [key.kid as string, createPublicKey({ key, format: 'jwk' })]),
    );
    loadedAt = Date.now();
  };
  const publicKey = async (kid: string) => {
    if (!keys.has(kid) && Date.now() - loadedAt > 60_000) {
      loading ??= load().finally(() => (loading = undefined));
      await loading.catch(() => undefined);
    }
    return keys.get(kid);
  };
  const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return async (request: FastifyRequest) => {
    const assertion = request.headers['cf-access-jwt-assertion'];
    if (typeof assertion !== 'string' || assertion.length > 16_384) return false;
    const [header, payload, signature, extra] = assertion.split('.');
    if (!header || !payload || !signature || extra !== undefined) return false;
    try {
      const head = decode(header);
      const claims = decode(payload);
      if (head.alg !== 'RS256' || typeof head.kid !== 'string') return false;
      const key = await publicKey(head.kid);
      if (
        !key ||
        !verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${payload}`),
          key,
          Buffer.from(signature, 'base64url'),
        )
      )
        return false;
      const now = Date.now() / 1000;
      const audiences: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      return (
        claims.iss === issuer &&
        audiences.includes(settings.audience) &&
        typeof claims.exp === 'number' &&
        claims.exp > now &&
        (typeof claims.nbf !== 'number' || claims.nbf <= now + 60) &&
        typeof claims.email === 'string' &&
        settings.emails.includes(claims.email.toLowerCase())
      );
    } catch {
      return false;
    }
  };
}
