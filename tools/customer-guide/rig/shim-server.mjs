// Local stand-in for Supabase REST + the Vercel functions, for screenshots only. Not part of the product.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const SECRET = 'bestie-local-jwt-secret-at-least-32-characters-long';
const PORT = 54321;
const DIST = '/tmp/pos-dist';
const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (p) => {
  const h = b({ alg: 'HS256', typ: 'JWT' }),
    pl = b(p);
  return `${h}.${pl}.${crypto
    .createHmac('sha256', SECRET)
    .update(h + '.' + pl)
    .digest('base64url')}`;
};
process.env.SUPABASE_URL = `http://127.0.0.1:${PORT}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = sign({
  role: 'service_role',
  iss: 'supabase',
  exp: 4102444800,
});
process.env.PRICE_URL_COINGECKO = `http://127.0.0.1:${PORT}/fake/coingecko`;
process.env.PRICE_URL_THAI_TICKER = `http://127.0.0.1:${PORT}/fake/ticker`;
process.env.SITE_URL = `http://127.0.0.1:${PORT}`;
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

const body = (req) =>
  new Promise((res) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => res(Buffer.concat(c)));
  });

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': '*',
        'access-control-expose-headers': '*',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      if (url.pathname === '/fake/coingecko') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"tether":{"thb":36.12}}');
      }
      if (url.pathname === '/fake/ticker') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"THB_USDT":{"last":36.08}}');
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const data = await body(req);
        const headers = { ...req.headers };
        delete headers.host;
        delete headers['content-length'];
        delete headers['accept-encoding'];
        const r = await fetch(
          `http://127.0.0.1:3011/${url.pathname.slice('/rest/v1/'.length)}${url.search}`,
          {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : data,
          },
        );
        const out = Buffer.from(await r.arrayBuffer());
        const h = {};
        r.headers.forEach((v, k) => {
          if (
            !['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k)
          )
            h[k] = v;
        });
        res.writeHead(r.status, { ...h, ...cors });
        return res.end(out);
      }
      if (url.pathname === '/auth/v1/user' || url.pathname === '/auth/v1/token') {
        const tokenStr = (req.headers.authorization || '').replace(/^Bearer /, '');
        let sub = null;
        try {
          sub = JSON.parse(Buffer.from(tokenStr.split('.')[1], 'base64url').toString()).sub;
        } catch {}
        if (url.pathname === '/auth/v1/token') {
          const d = JSON.parse((await body(req)).toString() || '{}');
          sub = sub || d.sub;
        }
        const q = `select json_build_object('id', id, 'aud','authenticated','role','authenticated','email', email, 'email_confirmed_at', now(), 'app_metadata', json_build_object('provider','email'), 'user_metadata', raw_user_meta_data, 'created_at', now(), 'updated_at', now())::text from auth.users where id = '${String(sub).replace(/[^0-9a-f-]/gi, '')}'`;
        const out = execFileSync(
          'psql',
          ['-h', '/tmp/devpg', '-p', '54998', '-U', 'postgres', '-d', 'demo', '-Atc', q],
          { encoding: 'utf8' },
        ).trim();
        res.writeHead(out ? 200 : 401, { 'content-type': 'application/json', ...cors });
        return res.end(out || '{"message":"no user"}');
      }
      if (url.pathname.startsWith('/auth/v1/') || url.pathname.startsWith('/realtime/')) {
        res.writeHead(404, { 'content-type': 'application/json', ...cors });
        return res.end('{"message":"not available in the screenshot rig"}');
      }
      if (url.pathname.startsWith('/api/')) {
        const file = join('/tmp/api-dist', url.pathname + '.mjs');
        if (!existsSync(file)) {
          res.writeHead(404);
          return res.end('no function');
        }
        const mod = await import(pathToFileURL(file).href);
        const fn = mod[req.method] ?? mod.default;
        const data = await body(req);
        const headers = { ...req.headers };
        delete headers['content-length'];
        const request = new Request(url.href, {
          method: req.method,
          headers,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : data,
        });
        const r = await (typeof fn === 'function'
          ? fn(request)
          : new Response('no handler', { status: 405 }));
        const out = Buffer.from(await r.arrayBuffer());
        const h = {};
        r.headers.forEach((v, k) => {
          if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) h[k] = v;
        });
        res.writeHead(r.status, h);
        return res.end(out);
      }
      let f = join(DIST, url.pathname);
      if (!existsSync(f) || statSync(f).isDirectory()) f = join(DIST, 'index.html');
      res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
      res.end(readFileSync(f));
    } catch (e) {
      console.error(e);
      res.writeHead(500);
      res.end(String(e));
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log('shim on', PORT));

export { sign };
