/**
 * Unit tests: the service-links route's URL handling.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/server/auth-context', () => ({
  authenticateRequest: vi.fn(async (req: { authed?: boolean }) => (req.authed ? { principal: { id: 'p' } } : null)),
}));

import { handleServicesRoutes } from '../../src/routes/services';

function call(authed: boolean, method = 'GET', path = '/api/services') {
  let status = 0;
  let body = '';
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: string) => {
      body = chunk ?? '';
    },
    setHeader: () => undefined,
  };
  const req = { authed, method, headers: {} };
  return handleServicesRoutes(req as never, res as never, new URL(`http://x${path}`)).then((handled) => ({
    handled,
    status,
    json: body ? JSON.parse(body) : null,
  }));
}

afterEach(() => {
  delete process.env['OCTO_PHOENIX_PUBLIC_URL'];
  delete process.env['OCTO_DEPLOY_URL'];
  delete process.env['OCTO_DEPLOY_TOOL'];
});

describe('GET /api/services', () => {
  it('ignores other paths and methods, and refuses anonymous callers', async () => {
    expect((await call(true, 'POST')).handled).toBe(false);
    expect((await call(true, 'GET', '/api/other')).handled).toBe(false);
    expect(await call(false)).toMatchObject({ handled: true, status: 401 });
  });

  it('reports a service with no URL as not set up', async () => {
    const { json } = await call(true);
    expect(json.services.map((s: { url: unknown }) => s.url)).toEqual([null, null]);
  });

  it('returns configured http(s) URLs and drops anything else', async () => {
    process.env['OCTO_PHOENIX_PUBLIC_URL'] = 'https://phoenix.example.test/';
    process.env['OCTO_DEPLOY_URL'] = 'javascript:alert(1)';
    process.env['OCTO_DEPLOY_TOOL'] = 'Coolify';
    const { json } = await call(true);
    expect(json.services[0]).toMatchObject({ id: 'traces', tool: 'Phoenix', url: 'https://phoenix.example.test/' });
    expect(json.services[1]).toMatchObject({ id: 'deploy', tool: 'Coolify', url: null });
  });
});
