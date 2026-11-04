// Matching running programs against the teacher's list of blocked apps.
// Names are compared without case or the .exe/.app extension, against both the
// executable and (on macOS) the .app bundle it lives in, so "Steam" catches
// /Applications/Steam.app/Contents/MacOS/steam_osx and "steam" catches steam.exe.

/** Programs that are never closed, whatever the list says: the OS shell and ClassMonitor itself. */
const PROTECTED = new Set([
  'explorer', 'dwm', 'winlogon', 'wininit', 'csrss', 'lsass', 'services', 'svchost', 'smss', 'taskmgr', 'sihost', 'ctfmon',
  'finder', 'dock', 'loginwindow', 'windowserver', 'systemuiserver', 'launchd', 'kernel_task', 'controlcenter',
  'electron', 'powershell', 'input-helper',
]);

export function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\.(exe|app)$/, '');
}

/** The names a running program answers to: its executable, plus any .app bundle in its path. */
export function programNames(processPath: string): string[] {
  const parts = processPath.split(/[\\/]/).filter(Boolean);
  const names = new Set<string>();
  if (parts.length) names.add(normalise(parts[parts.length - 1]));
  for (const part of parts) if (/\.app$/i.test(part)) names.add(normalise(part));
  return [...names];
}

function pattern(entry: string): RegExp {
  const escaped = normalise(entry).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Returns the blocked entry this program matches, or null (always null for protected programs). */
export function blockedBy(processPath: string, blocked: string[]): string | null {
  const names = programNames(processPath);
  if (names.some((n) => PROTECTED.has(n) || n.startsWith('classmonitor'))) return null;
  for (const entry of blocked) {
    const re = pattern(entry);
    if (names.some((n) => re.test(n))) return entry;
  }
  return null;
}

/** A readable name for the student's notice: the bundle name on macOS, else the executable. */
export function displayName(processPath: string): string {
  const parts = processPath.split(/[\\/]/).filter(Boolean);
  const bundle = parts.find((p) => /\.app$/i.test(p));
  return (bundle ?? parts[parts.length - 1] ?? processPath).replace(/\.(exe|app)$/i, '');
}
