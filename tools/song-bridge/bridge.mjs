#!/usr/bin/env node
// Bestie Song Bridge — runs in ONE karaoke room (a mini PC, a Raspberry Pi, a phone with Termux) and drives the venue's own karaoke system.
// It only PULLS from Bestie over HTTPS: no port is opened in the shop.
//
//   BESTIE_URL=https://bestie-pos.vercel.app  BRIDGE_KEY=<64 hex from Karaoke → Song bridge>  \
//   PLAY_CMD='adb -s 192.168.1.50:5555 shell am start -a android.intent.action.VIEW -d "https://www.youtube.com/watch?v={id}"' \
//   node tools/song-bridge/bridge.mjs
//
// PLAY_CMD runs once per song; {id} = the YouTube video id, {title} = its title (shell-quoted). When the command exits the song is reported as started;
// the song is reported finished when DONE_CMD (optional) exits with code 0 (for example a check of the TV's player state)
// or, at the latest, after STOP_AFTER_SECONDS (default 240). Nothing here ever reads the room's screen.
// Options: POLL_SECONDS (default 3). `--dry` prints what would run.
import { spawn } from 'node:child_process';

const { BESTIE_URL, BRIDGE_KEY, PLAY_CMD, DONE_CMD } = process.env;
const POLL = Math.max(1, Number(process.env.POLL_SECONDS) || 3) * 1000;
const STOP_AFTER = Math.max(10, Number(process.env.STOP_AFTER_SECONDS) || 240) * 1000;
const DRY = process.argv.includes('--dry');

if (!BESTIE_URL || !/^[0-9a-f]{64}$/.test(BRIDGE_KEY ?? '') || !PLAY_CMD) {
  console.error('Set BESTIE_URL, BRIDGE_KEY (64 hex) and PLAY_CMD. See the header of this file.');
  process.exit(2);
}
const api = `${BESTIE_URL.replace(/\/$/, '')}/api/karaoke/bridge`;
const headers = { Authorization: `Bearer ${BRIDGE_KEY}`, 'Content-Type': 'application/json' };

export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const fillCommand = (tpl, song) =>
  tpl.replaceAll('{id}', song.video_id).replaceAll('{title}', shellQuote(song.title));

const run = (cmd) =>
  new Promise((resolve) => {
    if (DRY) {
      console.log('[dry]', cmd);
      return resolve(0);
    }
    const c = spawn(cmd, { shell: true, stdio: 'inherit' });
    c.on('exit', (code) => resolve(code ?? 1));
    c.on('error', () => resolve(1));
  });
const call = async (method, body) => {
  const r = await fetch(api, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntilDone() {
  const end = Date.now() + STOP_AFTER;
  while (Date.now() < end) {
    await sleep(POLL);
    if (DONE_CMD && (await run(DONE_CMD)) === 0) return;
  }
}

async function main() {
  let busy = false;
  for (;;) {
    try {
      const { status, json } = await call('GET');
      if (status === 401) {
        console.error(
          'Bestie refused the key (switched off, replaced or the module is off). Waiting…',
        );
      } else if (json.ok && json.running && !busy) {
        const song = json.now ?? json.queue?.[0];
        if (song) {
          busy = true;
          console.log(`▶ ${song.title}`);
          const code = await run(fillCommand(PLAY_CMD, song));
          if (code !== 0) {
            console.error(`PLAY_CMD failed (exit ${code}); the song is removed from the queue.`);
            await call('POST', { song: song.id, status: 'removed' });
          } else {
            await call('POST', { song: song.id, status: 'playing' });
            await waitUntilDone();
            await call('POST', { song: song.id, status: 'done' });
          }
          busy = false;
        }
      }
    } catch (e) {
      console.error('No connection to Bestie, trying again:', e instanceof Error ? e.message : e);
    }
    await sleep(POLL);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
