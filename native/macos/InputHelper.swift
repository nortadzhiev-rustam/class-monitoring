// Remote-control input helper for macOS student computers.
// Reads one command per line on stdin (protocol in src/student/input.ts) and
// posts the matching CGEvents. macOS only delivers them when the launching app
// (ClassMonitor Student) has the Accessibility permission. While it runs it
// also prints "state password-prompt" when macOS puts up a password prompt
// (which screen sharing doesn't show), and "state ok" once it has gone.
//
// `--lock` instead swallows the student's own keyboard and mouse clicks while
// the lock screen or the teacher's screen is up (see src/student/input-lock.ts).
//
// `--mute` instead keeps the sound off until stdin closes, then puts it back
// (see src/student/mute.ts).
//
// `--dry-run` prints the events instead of posting them, for testing.

import CoreAudio
import CoreGraphics
import Foundation

let dryRun = CommandLine.arguments.contains("--dry-run")
let output = NSLock()

/// One line on stdout; the state watcher writes from another thread.
func say(_ line: String) {
  output.lock()
  print(line)
  fflush(stdout)
  output.unlock()
}
let source = CGEventSource(stateID: .hidSystemState)
/// Tags the events this helper posts, so a --lock helper lets remote control through.
let classMonitorMark: Int64 = 0x434D_4F4E

var heldButtons = Set<Int>()
var heldKeys = Set<CGKeyCode>()
var flags = CGEventFlags()
var lastPoint = CGEvent(source: nil)?.location ?? .zero

let modifierFlags: [CGKeyCode: CGEventFlags] = [
  0x38: .maskShift, 0x3C: .maskShift,
  0x3B: .maskControl, 0x3E: .maskControl,
  0x3A: .maskAlternate, 0x3D: .maskAlternate,
  0x37: .maskCommand, 0x36: .maskCommand,
]

func post(_ event: CGEvent?, _ description: @autoclosure () -> String) {
  guard let event = event else { return }
  if dryRun {
    say(description())
  } else {
    event.setIntegerValueField(.eventSourceUserData, value: classMonitorMark)
    event.post(tap: .cghidEventTap)
  }
}

func mouseTypes(_ button: Int) -> (down: CGEventType, up: CGEventType, drag: CGEventType, button: CGMouseButton) {
  switch button {
  case 2: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
  case 1: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
  default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
  }
}

func move(to point: CGPoint) {
  lastPoint = point
  var type = CGEventType.mouseMoved
  var button = CGMouseButton.left
  // While a button is held, macOS expects "dragged" events so selections and drags work.
  if let held = [0, 2, 1].first(where: heldButtons.contains) {
    let types = mouseTypes(held)
    type = types.drag
    button = types.button
  }
  let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  event?.flags = flags
  post(event, "move \(Int(point.x)) \(Int(point.y))")
}

func press(_ button: Int, down: Bool, at point: CGPoint, clicks: Int) {
  let types = mouseTypes(button)
  if down { heldButtons.insert(button) } else { heldButtons.remove(button) }
  let event = CGEvent(
    mouseEventSource: source, mouseType: down ? types.down : types.up,
    mouseCursorPosition: point, mouseButton: types.button)
  event?.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, clicks)))
  event?.flags = flags
  post(event, "button \(button) \(down ? "down" : "up") \(Int(point.x)) \(Int(point.y)) clicks=\(max(1, clicks))")
}

func scroll(dx: Int32, dy: Int32) {
  // DOM deltas are positive when scrolling down/right; CGEvent wheels are the opposite.
  let event = CGEvent(
    scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
    wheel1: -dy, wheel2: -dx, wheel3: 0)
  post(event, "scroll \(dx) \(dy)")
}

func key(_ code: CGKeyCode, down: Bool) {
  if down { heldKeys.insert(code) } else { heldKeys.remove(code) }
  let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
  if let flag = modifierFlags[code] {
    // Left and right modifiers share a flag; keep it while either is held.
    let twins = modifierFlags.filter { $0.value == flag }.map { $0.key }
    if twins.contains(where: heldKeys.contains) { flags.insert(flag) } else { flags.remove(flag) }
    event?.type = .flagsChanged
  }
  event?.flags = flags
  post(event, "key \(code) \(down ? "down" : "up") flags=\(flags.rawValue)")
}

func releaseAll() {
  for button in heldButtons { press(button, down: false, at: lastPoint, clicks: 1) }
  for code in heldKeys { key(code, down: false) }
  flags = []
}

/// The event tap while --lock is on (global, so the C callback can switch it back on).
var lockTap: CFMachPort?

/// --lock: swallows keys and mouse clicks until stdin closes (the lock ended, or
/// ClassMonitor quit or crashed). Events carrying `classMonitorMark` get
/// through. Exits with 3 when macOS refuses the tap (no Accessibility permission).
func runLock() -> Never {
  if !dryRun {
    let blocked: [CGEventType] = [
      .keyDown, .keyUp, .flagsChanged, .scrollWheel,
      .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
      .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
    ]
    let mask = blocked.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    let tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask,
      callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
          // macOS switches off a tap it thinks is stuck; switch it straight back on.
          if let tap = lockTap { CGEvent.tapEnable(tap: tap, enable: true) }
          return Unmanaged.passUnretained(event)
        }
        return event.getIntegerValueField(.eventSourceUserData) == classMonitorMark ? Unmanaged.passUnretained(event) : nil
      },
      userInfo: nil)
    guard let tap = tap else {
      FileHandle.standardError.write(Data("macOS refused the event tap (no Accessibility permission?); keyboard and mouse stay usable\n".utf8))
      exit(3)
    }
    lockTap = tap
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
  }
  say("locked")
  Thread {
    while readLine() != nil {}
    say("unlocked")
    exit(0)
  }.start()
  CFRunLoopRun()
  exit(0)
}

// MARK: - --mute

/// Something that silences an output device: its mute switch, or for devices
/// without one its volume, on the whole device or on one channel.
struct AudioControl: Hashable {
  let device: AudioObjectID
  let selector: AudioObjectPropertySelector
  let element: AudioObjectPropertyElement

  var isMute: Bool { selector == kAudioDevicePropertyMute }
  /// The value that means "no sound".
  var silent: Double { isMute ? 1 : 0 }
  var address: AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioDevicePropertyScopeOutput, mElement: element)
  }

  var settable: Bool {
    var addr = address
    guard AudioObjectHasProperty(device, &addr) else { return false }
    var yes = DarwinBoolean(false)
    return AudioObjectIsPropertySettable(device, &addr, &yes) == noErr && yes.boolValue
  }

  func read() -> Double? {
    var addr = address
    if isMute {
      var value = UInt32(0)
      var size = UInt32(MemoryLayout<UInt32>.size)
      return AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &value) == noErr ? Double(value) : nil
    }
    var value = Float32(0)
    var size = UInt32(MemoryLayout<Float32>.size)
    return AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &value) == noErr ? Double(value) : nil
  }

  func write(_ value: Double) {
    var addr = address
    if isMute {
      var raw = UInt32(value != 0 ? 1 : 0)
      AudioObjectSetPropertyData(device, &addr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &raw)
    } else {
      var raw = Float32(value)
      AudioObjectSetPropertyData(device, &addr, 0, nil, UInt32(MemoryLayout<Float32>.size), &raw)
    }
  }
}

/// The speakers or headphones sound goes to right now.
func defaultOutputDevice() -> AudioObjectID? {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: 0)
  var device = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device)
  return status == noErr && device != kAudioObjectUnknown ? device : nil
}

/// How to silence a device: its mute switch (whole device, else each channel), else its volume.
func silencers(_ device: AudioObjectID) -> [AudioControl] {
  for selector in [kAudioDevicePropertyMute, kAudioDevicePropertyVolumeScalar] {
    let whole = AudioControl(device: device, selector: selector, element: 0)
    if whole.settable { return [whole] }
    let channels = (1...8).map { AudioControl(device: device, selector: selector, element: AudioObjectPropertyElement($0)) }.filter { $0.settable }
    if !channels.isEmpty { return channels }
  }
  return []
}

/// --mute: keeps whichever device is playing silent until stdin closes, then
/// puts every control it changed back as it was.
func runMute() -> Never {
  var original: [AudioControl: Double] = [:]
  var warned = Set<AudioObjectID>()
  func silence() {
    guard !dryRun, let device = defaultOutputDevice() else { return }
    let controls = silencers(device)
    if controls.isEmpty && warned.insert(device).inserted {
      FileHandle.standardError.write(Data("this output has no mute or volume control macOS can change\n".utf8))
    }
    for control in controls {
      guard let value = control.read() else { continue }
      if original[control] == nil { original[control] = value }
      if value != control.silent { control.write(control.silent) }
    }
  }
  let closed = DispatchSemaphore(value: 0)
  Thread {
    while readLine() != nil {}
    closed.signal()
  }.start()
  silence()
  say("muted")
  // The student may turn it back up, or plug in headphones: keep it off.
  while closed.wait(timeout: .now() + 0.5) == .timedOut { silence() }
  for (control, value) in original { control.write(value) }
  say("unmuted")
  exit(0)
}

// MARK: - what remote control can't reach

/// macOS asks for a password (an administrator's, or the keychain's) in windows
/// of this process. They are left out of screen sharing, so the teacher sees
/// nothing there, and they may not take typing from other programs.
let passwordPromptOwners: Set<String> = ["SecurityAgent"]

func passwordPromptShown() -> Bool {
  guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return false
  }
  return windows.contains { passwordPromptOwners.contains($0[kCGWindowOwnerName as String] as? String ?? "") }
}

/// Prints "state <why>" whenever what's in front changes: "ok", or something remote control can't reach.
func watchState() {
  // Testing: pretend, so the whole path to the teacher's screen can be checked.
  let fake = dryRun ? ProcessInfo.processInfo.environment["CM_FAKE_INPUT_STATE"] : nil
  Thread {
    var last = ""
    while true {
      let state = fake ?? (passwordPromptShown() ? "password-prompt" : "ok")
      if state != last {
        say("state \(state)")
        last = state
      }
      Thread.sleep(forTimeInterval: 1)
    }
  }.start()
}

if CommandLine.arguments.contains("--lock") { runLock() }
if CommandLine.arguments.contains("--mute") { runMute() }

watchState()

while let line = readLine() {
  let parts = line.split(separator: " ").map(String.init)
  guard let command = parts.first else { continue }
  func number(_ i: Int) -> Double {
    guard i < parts.count, let value = Double(parts[i]), value.isFinite else { return 0 }
    return max(-1_000_000, min(1_000_000, value))
  }

  // Coordinates are global desktop points (negative for screens left of or
  // above the main one); "-" means wherever the pointer is now.
  switch command {
  case "m":
    move(to: CGPoint(x: number(1), y: number(2)))
  case "b":
    let point = parts.count > 3 && parts[3] == "-" ? lastPoint : CGPoint(x: number(3), y: number(4))
    if point != lastPoint { move(to: point) }
    press(Int(number(1)), down: number(2) == 1, at: point, clicks: Int(number(5)))
  case "w":
    scroll(dx: Int32(number(1)), dy: Int32(number(2)))
  case "k":
    key(CGKeyCode(max(0, min(255, number(1)))), down: number(2) == 1)
  case "r":
    releaseAll()
  default:
    continue
  }
}

releaseAll()
