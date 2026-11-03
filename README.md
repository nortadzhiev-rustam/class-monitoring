# ClassMonitor

A LAN classroom-management app in the spirit of NetSupport School: a **teacher console** that sees every student screen at once, and a **student agent** that runs on each Windows or macOS computer.

| Feature | How it works |
| --- | --- |
| Live thumbnails | Each agent sends a JPEG of its main screen every 2 s (unchanged screens are skipped) |
| Remote view | Click a student: their screen streams over WebRTC (up to 1920×1200, 20 fps) |
| Remote control | "Take control" sends your mouse and keyboard to the student; Cmd↔Ctrl are swapped between Mac and Windows |
| Lock screens | Full-screen lock with your message on every monitor, for everyone or one student |
| Show my screen | Your screen is streamed full-screen to every student |

## Try it on one computer

```bash
npm install
```

```bash
npm run build:native   # macOS only: builds the remote-control helper
```

In one terminal:

```bash
CM_CLASS_KEY=dev-class-key npm run teacher
```

In another:

```bash
CM_CLASS_KEY=dev-class-key CM_OVERLAY_WINDOWED=1 npm run student
```

The student appears in the console within a couple of seconds. `CM_OVERLAY_WINDOWED=1` shows the lock and broadcast screens as small windows instead of taking over your screen. If you do lock yourself for real, press **Cmd/Ctrl+Alt+Shift+U** (development builds only).

On macOS, grant **Screen Recording** to Electron (and **Accessibility** for remote control) in System Settings → Privacy & Security, then restart the apps.

### End-to-end test

```bash
npm run test:e2e
```

This starts both apps and checks discovery, thumbnails, lock/unlock, remote view, remote control (dry run: your mouse is never moved), broadcast, wrong-key rejection, and auto-unlock when the teacher disappears. Screenshots land in `tests/output/`.

## Deploying to a classroom

1. **Teacher:** install ClassMonitor Teacher (`npm run dist:teacher`). On first run it generates a class key. Open **Class settings** to see it, change the room name, and copy the student config.
2. **Students:** install ClassMonitor Student (`npm run dist:student`) and deploy the config file with your usual tools (GPO, Intune, Jamf):
   - Windows: `C:\ProgramData\ClassMonitor\student.json`
   - macOS: `/Library/Application Support/ClassMonitor/student.json`

   ```json
   { "room": "Lab 3", "classKey": "K7QF2-M9XRA-4TNWP-HB3ZD" }
   ```

   Add `"teacherHost": "10.0.4.20"` if the network blocks UDP broadcast, and `"displayName"` to override the computer name. Make the file readable by students but writable only by admins.
3. **macOS students:** push a PPPC profile through MDM that grants ClassMonitor Student **Screen Recording** and **Accessibility**. Without it each student has to approve the prompts by hand.
4. **Network:** students listen on UDP **47800** for teacher beacons; the teacher accepts TCP **47801**. The Windows installers add these firewall rules (domain and private profiles).

The student agent starts at login, shows a tray/menu-bar icon that says when the teacher is connected, watching or controlling, and cannot be quit in packaged builds.

## How it works

```
 Teacher console (Electron)                    Student agent (Electron, one per PC)
 ┌──────────────────────────┐   UDP beacon    ┌───────────────────────────────────┐
 │ server.ts                │ ──────────────▶ │ connection.ts  (discovery, link)  │
 │  UDP beacon every 2 s    │                 │                                   │
 │  WebSocket server :47801 │ ◀── WebSocket ─ │ main.ts        thumbnails, tray   │
 │  class state (lock, …)   │   (encrypted)   │ overlay.ts     lock / broadcast   │
 │                          │                 │ input.ts ──▶ native helper        │
 │ renderer/app.ts          │ ◀═══ WebRTC ══▶ │ renderer/agent.ts   (screen out)  │
 │  grid, viewer, broadcast │                 │ renderer/overlay.ts (teacher in)  │
 └──────────────────────────┘                 └───────────────────────────────────┘
```

- **Security** (`src/shared/secure-channel.ts`): teacher and student prove to each other that they know the class key (HMAC challenge-response), so a rogue console can't control students and a rogue agent can't join. Every message after that is AES-256-GCM encrypted with per-session keys, with replay protection. WebRTC media is DTLS-SRTP encrypted, and its fingerprints travel inside the encrypted channel.
- **Screen streams** use WebRTC with no STUN/TURN (LAN only). The side that has the screen makes the offer: the student for remote view, the teacher for broadcast.
- **Remote control** input is normalised to 0..1 across the student's primary display and injected by a small helper process: `native/macos/InputHelper.swift` (CGEvent) or `native/windows/input-helper.ps1` (SendInput).
- **Safety:** if the teacher disconnects, students are unlocked and every view/control session ends.

## Known limits of this first version

- Only the student's **primary display** is shown and controlled.
- **Lock screen** on Windows covers the screen and swallows keys, but Ctrl+Alt+Del and the Windows key still work. Fully blocking them needs a low-level keyboard hook or a Windows service. On macOS, kiosk mode blocks app switching and Force Quit.
- Remote control can't drive **elevated (admin) windows** or UAC prompts on Windows; that needs a SYSTEM service.
- **Broadcast** encodes one stream per student, which is fine for a typical class of about 30 on wired Ethernet. Larger rooms or Wi-Fi need an SFU or multicast.
- Anyone who can read `student.json` has the class key. Use a different key per room and keep the file admin-writable.
- Tested end-to-end on macOS only. The Windows paths (input helper, installer firewall rules) are written but not yet run on a Windows machine.

Ideas for next: student messaging and "raise hand", web/app blocking, URL launch, file send, attendance, and a SYSTEM service on Windows for a stronger lock.
