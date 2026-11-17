# ClassMonitor

A LAN classroom-management app in the spirit of NetSupport School: a **teacher console** that sees every student screen at once, and a **student agent** that runs on each Windows or macOS computer.

## Features

**Watch and control**

| Feature | How it works |
| --- | --- |
| Live thumbnails | Every student's screen every 2 s; with several monitors, all of them as arranged |
| Remote view | Click a student to stream their screen over WebRTC (up to 1920×1200, 20 fps), switching between their monitors |
| Remote control | "Take control" sends your mouse and keyboard to the screen you're viewing; Cmd↔Ctrl swap between Mac and Windows |
| Lock screens | Full-screen lock with your message on every monitor. While it (or your shown screen) is up, the student's keyboard and mouse are blocked and the taskbar / Dock is hidden |
| Show my screen | Your screen streamed full-screen to students; with several monitors, pick which one and switch while showing |

**Communicate**

| Feature | How it works |
| --- | --- |
| Messages | A pop-up on students' screens until they click OK |
| Student toolbar | A slim bar at the top of each student's screen while you're connected: who's connected, Raise hand, Chat (with unread count), Hand in work while you're collecting, and whether you're watching or controlling, or limiting websites or apps. It tucks into a small tab, slides out on hover, never takes the keyboard, and steps aside for the lock screen |
| Help requests | Students raise a hand from the toolbar, the tray or chat; you get a Help queue and a "Needs help" badge |
| Chat | One-to-one chat; the student's window opens when you write, without stealing their focus |
| Quick polls | Preset or custom answers, live results with names, each answer shown on the card |

**Classroom**

| Feature | How it works |
| --- | --- |
| Register | Students sign in with their name; see who's present or missing and export a CSV |
| Groups | Named groups as chips above the grid; any action can target a group |
| Arrange computers | Drag cards into your own order, e.g. to match where the computers stand in the room. The order is kept across restarts, new computers join at the end, and **Sort by name** puts it back |
| Send files | Hand out worksheets into students' `Documents/ClassMonitor/From teacher` |
| Collect work | Students hand in files into your `Documents/ClassMonitor/Collected/<title>/<student>` |

**Control**

| Feature | How it works |
| --- | --- |
| Open website / app | Opens a link in the default browser or an app by name |
| Close all apps | **Apps ▾ → Close all apps** asks every open app to quit after a 15-second warning, the same way Cmd+Q or a window's ✕ would, so apps with unsaved work can ask the student first. Finder, File Explorer and ClassMonitor stay open |
| Block apps | **Apps ▾ → Block apps**: named apps (with `*` wildcards) are closed whenever they start |
| Websites | Block all websites in one go, or block-list / allow-list sites, in Chrome and Edge via the ClassMonitor Web Filter extension |
| Power | Log off, restart or shut down after a 15-second warning; Wake-on-LAN for offline computers |

**Who does an action apply to?** Select cards (corner checkbox, Cmd/Ctrl-click, Shift-click) and actions go to the selection; with nothing selected they go to the group you're viewing, or everyone. The bar above the toolbar always says which. Lock, show my screen, polls, the register, collecting work, blocked apps and website rules also reach students who join late or reconnect.

Students always see what's happening: the tray icon says when the teacher is connected, watching or controlling, and every message, block, file and power action shows up on their screen.

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

The student appears in the console within a couple of seconds. `CM_OVERLAY_WINDOWED=1` shows the lock and broadcast screens as small windows instead of taking over your screen. If you do lock yourself for real, press **Cmd/Ctrl+Alt+Shift+U** (development builds only). Development builds never block the keyboard and mouse (installed apps do); set `CM_INPUT_LOCK=1` to try it, and keep the teacher on another computer.

On macOS, grant **Screen Recording** to Electron (and **Accessibility** for remote control) in System Settings → Privacy & Security, then restart the apps.

### Tests

```bash
npm test           # unit tests
```

```bash
npm run test:e2e   # both apps, end to end, on this computer
```

The end-to-end suite starts a teacher console and several student agents and exercises every feature. Anything that would affect the computer running it is simulated: remote control, opening sites and apps, and power actions run in dry-run mode, the web filter extension is played by the test speaking Chrome's native-messaging protocol, and Wake-on-LAN packets go to a test port. Screenshots land in `tests/output/`. The multi-monitor steps only run when the computer has two or more displays.

```bash
npm run test:load  # "Show my screen" to 24 students on this computer
```

The load test starts a console and 24 student agents (`node tests/load-broadcast.mjs 30` for another class size), shows the teacher's screen to all of them and reports each student's frame rate and how responsive the console stays. Their windows open on screen while it runs.

### App icons

The icons are drawn in `build/icon-teacher.svg` and `build/icon-student.svg`. After changing one, run `npm run icons` to render the 1024×1024 PNGs that the `.app`, `.dmg` and Windows installers are built with.

## Deploying to a classroom

1. **Teacher:** install ClassMonitor Teacher (`npm run dist:teacher`). On first run it generates a class key. Open **Class settings** to see it, change the room name, and copy the student config.
2. **Students:** install ClassMonitor Student (`npm run dist:student`). Then either:

   **Let students join themselves.** On first launch the student app opens a **Join your class** window that lists the classes it can hear on the network. The student picks theirs and types the class key. Once a teacher has accepted the key the choice is locked in, so students can't switch themselves out of a class. The window only comes back if the teacher later rejects the key (for example after generating a new one).

   **Or deploy the config file** with your usual tools (GPO, Intune, Jamf). This skips the window entirely and always wins over a student's own choice:
   - Windows: `C:\ProgramData\ClassMonitor\student.json`
   - macOS: `/Library/Application Support/ClassMonitor/student.json`

   ```json
   { "room": "Lab 3", "classKey": "K7QF2-M9XRA-4TNWP-HB3ZD" }
   ```

   Optional: `"teacherHost": "10.0.4.20"` if the network blocks UDP broadcast, `"displayName"` to override the computer name, `"extensionIds"` for the published web filter (below). Make the file readable by students but writable only by admins.

   **Save student.json…** in the teacher's Class settings writes this file for you. The Windows student installer creates `C:\ProgramData\ClassMonitor` (admins can write, students only read). File Explorer hides `ProgramData`: paste the path into the address bar. On macOS, create `/Library/Application Support/ClassMonitor` yourself.
3. **macOS students:** push a PPPC profile through MDM that grants ClassMonitor Student **Screen Recording**, **Accessibility** (remote control) and **Automation** of System Events and loginwindow (power controls). Without it each student approves the prompts by hand.
4. **Network:** students listen on UDP **47800** for teacher beacons; the teacher accepts TCP **47801**. The Windows installers add these firewall rules (domain and private profiles). Wake-on-LAN also needs it turned on in each PC's firmware and network card settings.

The student agent starts at login and has no way to quit it from the app (no menu, no Dock icon). It never blocks logging out or shutting down. On Windows the installer and uninstaller stop it themselves, so updating or removing it (Settings → Apps, admin rights needed) doesn't ask anyone to close it.

### Website blocking: the Chrome/Edge extension

Website rules are applied by the **ClassMonitor Web Filter** extension, which talks to the student app on the same computer. The student app registers itself with Chrome and Edge for the logged-in user automatically. What you do once:

1. `npm run pack:extension` makes `release/classmonitor-web-filter-<version>.zip`.
2. Publish it **unlisted** on the [Chrome Web Store](https://chrome.google.com/webstore/devconsole) (one-off $5 developer fee) and on [Microsoft Edge Add-ons](https://partner.microsoft.com/dashboard/microsoftedge/) (free). Each store gives the extension an ID.
3. Add both IDs to `student.json`: `"extensionIds": ["<chrome id>", "<edge id>"]`.
4. Force-install it by policy so students can't remove it:
   - Chrome: `ExtensionInstallForcelist` = `<chrome id>;https://clients2.google.com/service/update2/crx` (Windows: `HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist`; macOS: a `com.google.Chrome` configuration profile).
   - Edge: `ExtensionInstallForcelist` = `<edge id>;https://edge.microsoft.com/extensionwebstorebase/v1/crx` (Windows: `HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist`; macOS: a `com.microsoft.Edge` profile).

**Websites ▾ → Block all websites** stops every page from opening in Chrome and Edge (an allow-list with nothing on it); **Allow all websites** lifts it. It covers browsers only: other apps that use the internet keep working, so pair it with **Apps ▾ → Block apps** if needed.

While rules are on, Firefox, Safari and other browsers the extension can't reach are closed (you can switch this off under **Choose sites…**, and Block all websites follows that choice). Cards say **Web filter missing** where Chrome or Edge is open without the extension.

To try it before publishing: load `dist/extension` unpacked (chrome://extensions → Developer mode → Load unpacked) and start the student app once with `CM_REGISTER_HOST=1`, which registers the development build with Chrome and Edge for your user.

## How it works

```
 Teacher console (Electron)                      Student agent (Electron, one per PC)
 ┌────────────────────────────┐   UDP beacon    ┌──────────────────────────────────────┐
 │ server.ts   beacons, links │ ──────────────▶ │ connection.ts   discovery, link      │
 │ policy.ts   per-student    │ ◀── WebSocket ─ │ main.ts         applies the policy   │
 │             lock, poll, …  │   (encrypted)   │ overlay, prompts, chat, files, power │
 │ roster.ts   known students │                 │ app-blocker, input ──▶ native helper │
 │ files.ts    send / collect │ ◀══ WebRTC ════ │ renderer/agent.ts   (screens out)    │
 │ renderer/   grid, panels   │                 │ web.ts ◀── socket ── native host ◀── │
 └────────────────────────────┘                 │                     Chrome extension │
                                                └──────────────────────────────────────┘
```

- **Security** (`src/shared/secure-channel.ts`): teacher and student prove to each other that they know the class key (HMAC challenge-response), so a rogue console can't control students and a rogue agent can't join. Every message after that is AES-256-GCM encrypted with per-session keys, with replay protection; that includes the teacher's screen when shown to the class. Remote view's WebRTC media is DTLS-SRTP encrypted, and its fingerprints travel inside the encrypted channel. Anything a student sends (names, files, status) is validated by the console before use.
- **Policy** (`src/teacher/policy.ts`): what the teacher has switched on for each student (lock, broadcast, poll, register, collection, blocked apps, website rules) is sent whole whenever it changes and on every connect, so late joiners and reconnects match their class. If the teacher disconnects, the student drops all of it.
- **Files** travel in 256 KB chunks inside the encrypted channel, checksum-verified, with safe file names and no overwriting.
- **Show my screen** encodes the teacher's screen once, in hardware where possible (WebCodecs H.264, `src/teacher/renderer/screen-encoder.ts`), and `src/teacher/broadcast-relay.ts` sends the same frames to every student over their encrypted link; students decode and draw them. The teacher's computer does the same work for any class size. A student whose link backs up skips ahead to the next keyframe instead of holding back the others.
- **Remote control** maps 0..1 positions on the viewed monitor to desktop coordinates, injected by `native/macos/InputHelper.swift` (CGEvent) or `native/windows/input-helper.ps1` (SendInput across the virtual desktop).
- **Web filter**: the extension (`src/extension/`) uses declarativeNetRequest; the browser starts the student app as its native-messaging host (`src/student/native-host.ts`), which relays to the agent over a local socket guarded by a per-install secret.

## Known limits

- **Not yet run on Windows.** Everything is tested end to end on macOS. The Windows paths are written but unverified: the input helper (including multi-monitor and high-DPI coordinates), `tasklist`-based app blocking, `shutdown`, native-messaging registration in the registry, and installer firewall rules.
- **Multi-monitor** compositing, the screen switcher and control on a second screen are unit-tested, but the end-to-end step was skipped on the single-display development Mac.
- **The web filter** has been exercised through its native-messaging bridge, not yet inside a real Chrome or Edge.
- **Lock screen and shown screen** block the keyboard and mouse with the student's own rights. On Windows, low-level hooks (`native/windows/lock-helper.ps1`) swallow every key including the Windows key and Alt+Tab, and the taskbar is hidden; Ctrl+Alt+Del can't be blocked, so a student can still reach Task Manager from there unless Group Policy turns it off. On macOS an event tap does the same and needs the **Accessibility** permission (the same one remote control needs); without it only kiosk mode protects the lock screen. Remote control can't drive elevated windows or UAC prompts; that needs a SYSTEM service.
- **App blocking and power** act with the student's own rights: they can only close the student's own programs, and power actions need the OS to allow standard users to restart (the default on Windows client editions).
- **Broadcast** is encoded once but sent to each student separately: the teacher's link carries up to ~30 Mbps for a full class (usually far less for screen content), fine on wired Ethernet. A teacher on busy Wi-Fi, or much larger rooms, would need multicast.
- Anyone who can read `student.json` has the class key. Use a different key per room and keep the file admin-writable.
- Apps aren't code-signed yet, so Windows SmartScreen and macOS Gatekeeper warn on first launch.
