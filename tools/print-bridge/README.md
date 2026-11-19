# Bestie print bridge

For LAN / WiFi receipt printers (port 9100). Browsers cannot talk raw TCP, so run this on any computer in the shop:

```bash
node tools/print-bridge/print-bridge.mjs --printer 192.168.1.50
```

Then in Bestie: **Printer settings → Add a printer → Network**, address `http://<that computer's IP>:9101/print`.

- Node 18+, no packages. Only the site given by `--origin` may print (default `https://bestie-pos.vercel.app`).
- Browsers on an https page may refuse plain-http local addresses (mixed content). Chrome allows `http://localhost`; for another computer use a local https proxy or the USB / Bluetooth methods. **Not verified on real hardware from the build sandbox.**
