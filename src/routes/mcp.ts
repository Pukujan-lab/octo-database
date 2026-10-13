/**
 * Remote MCP endpoint (Streamable HTTP) for hosted clients.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { getPublicOrigin } from '../lib/public-origin';
import { authenticateRequest } from '../server/auth-context';
import { bearerToken, handleMcpRequest } from '../server/mcp-http';
import { sendWwwAuthenticate } from '../server/oauth';
import { PORT } from '../server/runtime';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleMcpRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 1b. Remote MCP endpoint (Streamable HTTP) for hosted clients such as
  // ChatGPT. A caller authenticates with an Octo bearer key or an OAuth access
  // token; when neither is present the 401 carries the RFC 6750 challenge that
  // points a client at the authorization server. /mcp/<key> is retired: a
  // long-lived key does not belong in a URL.
  if (pathname === '/mcp') {
    const auth = await authenticateRequest(req);
    const token = bearerToken(req);
    if (!auth || !token) {
      sendWwwAuthenticate(res, getPublicOrigin(req, url));
      return true;
    }
    await handleMcpRequest(req, res, { baseUrl: `http://127.0.0.1:${PORT}`, token });
    return true;
  }

  return false;
}
