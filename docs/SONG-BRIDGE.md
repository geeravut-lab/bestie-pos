# Bestie Song Bridge (owner order 8.1)

A small program in ONE karaoke room that drives the venue's own karaoke system from the room's Bestie song queue.

## How it works
1. In **Karaoke → the room → Song bridge** press *Make a song bridge key*. The 64-hex key is shown once (only its SHA-256 is stored; a new key stops the old one at once; *Switch off* removes it).
2. On a mini PC / Raspberry Pi / phone in the room run `tools/song-bridge/bridge.mjs` (Node 20+) with `BESTIE_URL`, `BRIDGE_KEY` and `PLAY_CMD`.
3. The bridge **pulls** `GET /api/karaoke/bridge` every few seconds: while the room's timer runs it gets what is playing and what waits. For the next song it runs `PLAY_CMD` (`{id}` = YouTube video id, `{title}` = quoted title), reports `playing`, waits for `DONE_CMD` to succeed (or `STOP_AFTER_SECONDS`), then reports `done`. A failing `PLAY_CMD` removes the song from the queue. Nothing opens a port in the shop.

## `PLAY_CMD` examples (the shop chooses the route)
- Android TV over the network: `adb -s 192.168.1.50:5555 shell am start -a android.intent.action.VIEW -d "https://www.youtube.com/watch?v={id}"`
- A PC with a browser kiosk: `chromium --kiosk "https://www.youtube.com/watch?v={id}&autoplay=1"`
- Any other system: your own script that takes the video id.
Bestie's own in-room player (`/karaoke/player/<room>`) needs no bridge at all; the bridge is for venues that already have a system.

## Rules (database: `bridge_karaoke_poll`, `bridge_karaoke_song`)
- The key belongs to one room; it can touch only that room's songs; module `karaoke.songs` must be on; a switched-off room refuses.
- A song moves queued → playing → done (or removed); a finished song cannot start again; starting a song finishes the one before.
- Rate limits: 300 / minute per address, 90 / minute per key.

## Not tried
Not run against a real TV, adb device or YouTube from the build environment. YouTube's own terms about playing videos in a commercial venue and music public-performance licensing are the owner's and the lawyer's to read (docs/KARAOKE-AI.md).
