# Local LAN Sync

Lightweight, **100% offline**, and **manual-only** vault synchronization over your local Wi-Fi/LAN network between desktop computers and mobile devices (Android, iOS, Windows, macOS, and Linux).

## Features

- **Completely local & offline:** Transfers notes and attachments directly over your home/office Wi-Fi without cloud storage, third-party servers, or internet access.
- **Manual sync only (zero background syncing):** No file watchers, no timers, and no automatic overwrites. Synchronization only happens when you click the **Sync now** button or run the command.
- **Fast incremental 3-way diff:** Uses cached file modification times and sizes to skip unchanged files, hashing and transferring only actual changes (Markdown notes, images, PDFs, and binary attachments).
- **Safe conflict & deletion handling:**
  - Deleted files are moved to trash using your configured trash preference.
  - Simultaneous edits on both devices never overwrite each other — a timestamped `(Conflict ...)` copy is preserved on both devices.
- **Automatic Wi-Fi discovery & easy pairing:**
  - **Phone or PC client:** Click **Scan Wi-Fi and connect** to automatically detect your host computer on the local network and pair with one tap (requires explicit approval on the host).
  - **QR code pairing:** Optionally scan the host's QR code with your phone camera via `obsidian://local-sync-pair`.
  - **Automatic IP recovery:** If your router changes the host's local IP address via DHCP, the client automatically scans the local subnet and reconnects.

## Network & Privacy Disclosure

- **Local network only:** This plugin does **not** connect to the internet, does **not** collect analytics or telemetry, and does **not** use any external APIs.
- **Desktop host server:** When enabled on desktop, a lightweight Node.js HTTP server listens passively on your local network (`0.0.0.0:27123` by default).
- **Explicit authentication & approval:**
  - Pairing requires explicit user approval via a modal on the host computer (or scanning the host's private QR code).
  - All file endpoints require a randomly generated secret token (`X-Sync-Token` header).
  - The vault configuration folder (`app.vault.configDir`) is always protected and excluded from sync.

## How to Use

1. Install and enable **Local LAN Sync** on both your desktop computer (Host) and your mobile device or second computer (Client).
2. Ensure both devices are connected to the same Wi-Fi/LAN network.
3. On the **Client** device, open **Settings → Local LAN Sync** and click **Scan Wi-Fi and connect** (or scan the QR code shown by **Pair new device** on the Host).
4. Click **Connect** next to your host computer's name, then click **Approve** on the host computer.
5. Whenever you want to sync changes, click the **Sync** ribbon icon or run **Local LAN Sync: Sync now** from the Command Palette.

### Windows Firewall Note

If your phone or second PC cannot discover your Windows host computer, allow inbound TCP port `27123` in Windows Firewall (run PowerShell as Administrator):

```powershell
New-NetFirewallRule -DisplayName "Obsidian Local LAN Sync" -Direction Inbound -Protocol TCP -LocalPort 27123 -Action Allow -Profile Any
```

## Building from Source

```bash
npm install
npm run build
```

This generates `main.js`. Copy `main.js`, `manifest.json`, and `styles.css` into `<Vault>/.obsidian/plugins/local-lan-sync/`.

## License

[MIT](LICENSE)
