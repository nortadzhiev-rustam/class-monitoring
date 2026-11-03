// Maps DOM KeyboardEvent.code values (physical keys, layout independent) to
// native key codes: macOS virtual key codes (kVK_*) and Windows virtual-key codes.
// `ext` marks Windows "extended" keys, which need KEYEVENTF_EXTENDEDKEY.

interface NativeKey {
  mac: number;
  win: number;
  ext?: boolean;
}

const letters: Record<string, number> = {
  A: 0x00, B: 0x0b, C: 0x08, D: 0x02, E: 0x0e, F: 0x03, G: 0x05, H: 0x04, I: 0x22,
  J: 0x26, K: 0x28, L: 0x25, M: 0x2e, N: 0x2d, O: 0x1f, P: 0x23, Q: 0x0c, R: 0x0f,
  S: 0x01, T: 0x11, U: 0x20, V: 0x09, W: 0x0d, X: 0x07, Y: 0x10, Z: 0x06,
};

const digits = [0x1d, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1a, 0x1c, 0x19];
const numpadDigits = [0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5b, 0x5c];
const functionKeys = [0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6d, 0x67, 0x6f];

const KEYS: Record<string, NativeKey> = {
  Enter: { mac: 0x24, win: 0x0d },
  Tab: { mac: 0x30, win: 0x09 },
  Space: { mac: 0x31, win: 0x20 },
  Backspace: { mac: 0x33, win: 0x08 },
  Escape: { mac: 0x35, win: 0x1b },
  CapsLock: { mac: 0x39, win: 0x14 },

  ShiftLeft: { mac: 0x38, win: 0xa0 },
  ShiftRight: { mac: 0x3c, win: 0xa1 },
  ControlLeft: { mac: 0x3b, win: 0xa2 },
  ControlRight: { mac: 0x3e, win: 0xa3, ext: true },
  AltLeft: { mac: 0x3a, win: 0xa4 },
  AltRight: { mac: 0x3d, win: 0xa5, ext: true },
  MetaLeft: { mac: 0x37, win: 0x5b, ext: true },
  MetaRight: { mac: 0x36, win: 0x5c, ext: true },
  ContextMenu: { mac: 0x6e, win: 0x5d, ext: true },

  ArrowLeft: { mac: 0x7b, win: 0x25, ext: true },
  ArrowUp: { mac: 0x7e, win: 0x26, ext: true },
  ArrowRight: { mac: 0x7c, win: 0x27, ext: true },
  ArrowDown: { mac: 0x7d, win: 0x28, ext: true },
  Home: { mac: 0x73, win: 0x24, ext: true },
  End: { mac: 0x77, win: 0x23, ext: true },
  PageUp: { mac: 0x74, win: 0x21, ext: true },
  PageDown: { mac: 0x79, win: 0x22, ext: true },
  Insert: { mac: 0x72, win: 0x2d, ext: true },
  Delete: { mac: 0x75, win: 0x2e, ext: true },

  Minus: { mac: 0x1b, win: 0xbd },
  Equal: { mac: 0x18, win: 0xbb },
  BracketLeft: { mac: 0x21, win: 0xdb },
  BracketRight: { mac: 0x1e, win: 0xdd },
  Backslash: { mac: 0x2a, win: 0xdc },
  Semicolon: { mac: 0x29, win: 0xba },
  Quote: { mac: 0x27, win: 0xde },
  Backquote: { mac: 0x32, win: 0xc0 },
  Comma: { mac: 0x2b, win: 0xbc },
  Period: { mac: 0x2f, win: 0xbe },
  Slash: { mac: 0x2c, win: 0xbf },
  IntlBackslash: { mac: 0x0a, win: 0xe2 },

  NumpadMultiply: { mac: 0x43, win: 0x6a },
  NumpadAdd: { mac: 0x45, win: 0x6b },
  NumpadSubtract: { mac: 0x4e, win: 0x6d },
  NumpadDecimal: { mac: 0x41, win: 0x6e },
  NumpadDivide: { mac: 0x4b, win: 0x6f, ext: true },
  NumpadEnter: { mac: 0x4c, win: 0x0d, ext: true },
  NumpadEqual: { mac: 0x51, win: 0x92 },
  NumLock: { mac: 0x47, win: 0x90, ext: true },
};

for (const [letter, mac] of Object.entries(letters)) KEYS[`Key${letter}`] = { mac, win: letter.charCodeAt(0) };
digits.forEach((mac, n) => (KEYS[`Digit${n}`] = { mac, win: 0x30 + n }));
numpadDigits.forEach((mac, n) => (KEYS[`Numpad${n}`] = { mac, win: 0x60 + n }));
functionKeys.forEach((mac, i) => (KEYS[`F${i + 1}`] = { mac, win: 0x70 + i }));

const META_CONTROL_SWAP: Record<string, string> = {
  MetaLeft: 'ControlLeft',
  MetaRight: 'ControlRight',
  ControlLeft: 'MetaLeft',
  ControlRight: 'MetaRight',
};

/**
 * Looks up the native key for `code` on the student's platform. When teacher and
 * student differ (Mac <-> Windows), Cmd and Ctrl are swapped so shortcuts like
 * Cmd+C on the teacher's Mac become Ctrl+C on a Windows student.
 */
export function nativeKey(code: string, studentPlatform: string, teacherPlatform: string): NativeKey | undefined {
  const crossPlatform = (studentPlatform === 'darwin') !== (teacherPlatform === 'darwin');
  return KEYS[crossPlatform ? (META_CONTROL_SWAP[code] ?? code) : code];
}
