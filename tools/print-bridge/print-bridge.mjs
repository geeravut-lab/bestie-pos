#!/usr/bin/env node
// Bestie print bridge: a browser cannot open a raw TCP connection, so this tiny program (run on any computer in the
// shop, Node 18+, no packages) receives the receipt bytes by HTTP POST and forwards them to the printer's port 9100.
//
//   node print-bridge.mjs --printer 192.168.1.50 [--printer-port 9100] [--port 9101] [--origin https://bestie-pos.vercel.app]
//
// In Bestie: Printer settings -> Add a printer -> Network -> address http://<this computer's IP>:9101/print
import http from 'node:http';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const printerHost = args.printer;
const printerPort = Number(args['printer-port'] ?? 9100);
const listenPort = Number(args.port ?? 9101);
const origin = args.origin ?? 'https://bestie-pos.vercel.app';
const MAX_BYTES = 2_000_000;

if (!printerHost) {
  console.error(
    'Usage: node print-bridge.mjs --printer <printer IP> [--printer-port 9100] [--port 9101] [--origin <site>]',
  );
  process.exit(1);
}

const cors = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
};

function toPrinter(bytes) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: printerHost, port: printerPort, timeout: 8000 }, () =>
      s.end(bytes),
    );
    s.on('close', (hadError) => (hadError ? reject(new Error('connection error')) : resolve()));
    s.on('timeout', () => s.destroy(new Error('timeout')));
    s.on('error', reject);
  });
}

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.method !== 'POST' || req.url !== '/print') return res.writeHead(404, cors).end();
    if (req.headers.origin && req.headers.origin !== origin) return res.writeHead(403, cors).end();
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        res.writeHead(413, cors).end();
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      toPrinter(Buffer.concat(chunks)).then(
        () => res.writeHead(200, cors).end('ok'),
        (e) => {
          console.error('print failed:', e.message);
          res.writeHead(502, cors).end();
        },
      );
    });
  })
  .listen(listenPort, () =>
    console.log(
      `Bestie print bridge: POST http://<this computer>:${listenPort}/print -> ${printerHost}:${printerPort} (allowed site: ${origin})`,
    ),
  );
