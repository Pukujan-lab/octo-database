/**
 * Octo MCP server (stdio).
 *
 * Lets an agent manage Octo workspaces through the same public API a human or
 * script uses. The token decides the reach: an account-wide key
 * (`octo_live_acc_`) for automated management across every workspace the
 * principal belongs to, or a workspace-scoped key (`octo_live_ws_`) confined to
 * one workspace. No database or provider credentials are read here.
 *
 * Usage (MCP client config):
 *   command: npx
 *   args: ["tsx", "scripts/octo-mcp.ts"]
 *   env: { OCTO_MCP_TOKEN: "octo_live_...", OCTO_MCP_BASE_URL: "https://..." }
 *
 * Env:
 *   OCTO_MCP_TOKEN      required; an Octo API key
 *   OCTO_MCP_BASE_URL   default http://localhost:3001
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OctoApi } from '../src/mcp/client';
import { createOctoMcpServer, restrictToCapabilities } from '../src/mcp/server';

const token = process.env['OCTO_MCP_TOKEN'];
if (!token) {
  console.error('OCTO_MCP_TOKEN is required (an Octo API key).');
  process.exit(1);
}

const baseUrl = process.env['OCTO_MCP_BASE_URL'] ?? 'http://localhost:3001';

const api = new OctoApi({ baseUrl, token });
const server = createOctoMcpServer(api);
await restrictToCapabilities(server, api);
await server.connect(new StdioServerTransport());
