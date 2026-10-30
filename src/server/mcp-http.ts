/**
 * Remote (Streamable HTTP) MCP endpoint.
 *
 * Octo's MCP adapter (src/mcp/server.ts) is stdio-only: a local process for a
 * CLI or editor. A hosted client such as ChatGPT cannot reach that, so this
 * module exposes the same tool server over Streamable HTTP at /mcp,
 * authenticated by the same bearer keys the rest of the API accepts — the
 * token decides the reach, exactly as the stdio adapter's docs promise.
 *
 * Stateless (`sessionIdGenerator: undefined`): each request is independent, so
 * a remote client needs no session affinity. Every request gets a fresh
 * McpServer wired to a per-request OctoApi carrying the caller's own token, so
 * neither state nor a token ever crosses requests.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { OctoApi } from '../mcp/client';
import { createOctoMcpServer, restrictToCapabilities } from '../mcp/server';

/** The bearer token from the request, or null when the header is absent. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/**
 * Serves one /mcp request as the caller whose token it carries. The MCP tools
 * call back into this same server over loopback, so `baseUrl` is the local
 * listener and the token supplies the authority.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: { baseUrl: string; token: string }
): Promise<void> {
  const api = new OctoApi({ baseUrl: options.baseUrl, token: options.token });
  const server = createOctoMcpServer(api);
  await restrictToCapabilities(server, api);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    // This must never reach handleRequest's outer catch: that catch answers
    // with sendJson, and once a response has started writeHead throws
    // ERR_HTTP_HEADERS_SENT out of an un-awaited promise — an unhandled
    // rejection, which terminates the single-process server.
    if (res.headersSent) {
      res.end();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }));
  }
}
