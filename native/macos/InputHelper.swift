// Remote-control input helper for macOS student computers.
// Reads one command per line on stdin (protocol in src/student/input.ts) and
// posts the matching CGEvents. macOS only delivers them when the launching app
// (ClassMonitor Student) has the Accessibility permission.
//
// `--dry-run` prints the events instead of posting them, for testing.

import CoreGraphics
import Foundation

let dryRun = CommandLine.arguments.contains("--dry-run")
let source = CGEventSource(stateID: .hidSystemState)

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
    print(description())
    fflush(stdout)
  } else {
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
