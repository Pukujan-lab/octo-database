/**
 * Serves the built SPA from dist/ when present, with an HTML navigation fallback.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { sendStaticFile } from '../server/static-file';
import * as fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';

export async function handleStaticRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // Static asset serving if dist/ directory exists (standalone/production)
  const distPath = path.resolve(process.cwd(), 'dist');

  if (fs.existsSync(distPath) && req.method === 'GET') {
    const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.join(distPath, relPath);
    const normalizedDist = distPath.endsWith(path.sep) ? distPath : distPath + path.sep;
    // Prevent path traversal
    if ((filePath === distPath || filePath.startsWith(normalizedDist)) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentTypes: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
      };
      const contentType = contentTypes[ext] ?? 'application/octet-stream';
      sendStaticFile(res, filePath, contentType, req.headers.range);
      return true;
    }

    // SPA fallback for HTML navigation requests (excluding /api routes)
    const indexPath = path.join(distPath, 'index.html');
    if (!pathname.startsWith('/api/') && fs.existsSync(indexPath) && (!path.extname(pathname) || req.headers.accept?.includes('text/html'))) {
      sendStaticFile(res, indexPath, 'text/html; charset=utf-8');
      return true;
    }
  }

  return false;
}
