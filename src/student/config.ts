// Student agent configuration. IT deploys the system-wide file (students can't
// edit it). Without one, the first-run "Join your class" window writes a
// per-user file. Environment variables are for development.
//
//   { "room": "Lab 3", "classKey": "K7QF2-M9XRA-4TNWP-HB3ZD", "teacherHost": "10.0.4.20" }

import fs from 'node:fs';
import path from 'node:path';
import { CONTROL_PORT } from '../shared/protocol';

export interface StudentConfig {
  room: string;
  classKey: string;
  /** Connect directly when UDP broadcast discovery is blocked on the network. */
  teacherHost?: string;
  teacherPort: number;
  /** Overrides the computer name shown to the teacher. */
  displayName?: string;
}

export function systemConfigPath(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'ClassMonitor', 'student.json');
    case 'darwin':
      return '/Library/Application Support/ClassMonitor/student.json';
    default:
      return '/etc/class-monitor/student.json';
  }
}

function readJson(file: string): Partial<StudentConfig> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[config] ignoring ${file}: ${(err as Error).message}`);
    return {};
  }
}

function userConfigPath(userDataDir: string): string {
  return path.join(userDataDir, 'student.json');
}

/**
 * True when IT (system file) or the environment supplies the class key. The
 * student's own setup window is never offered then, since it couldn't override it.
 */
export function isManagedConfig(): boolean {
  return Boolean(process.env.CM_CLASS_KEY || readJson(systemConfigPath()).classKey);
}

export interface UserConfig {
  room: string;
  classKey: string;
  teacherHost?: string;
  /** Set once a teacher accepted these settings; after that the student can't change them. */
  confirmed: boolean;
}

/** Written by the first-run "Join your class" window. */
export function saveUserConfig(userDataDir: string, config: UserConfig): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  const { room, classKey, teacherHost, confirmed } = config;
  const json = JSON.stringify({ room, classKey, teacherHost, confirmed }, null, 2);
  fs.writeFileSync(userConfigPath(userDataDir), json, { mode: 0o600 });
}

export function readUserConfig(userDataDir: string): Partial<UserConfig> {
  return readJson(userConfigPath(userDataDir)) as Partial<UserConfig>;
}

/** Returns null when no class key is configured anywhere. */
export function loadStudentConfig(userDataDir: string): StudentConfig | null {
  const env: Partial<StudentConfig> = {
    room: process.env.CM_ROOM,
    classKey: process.env.CM_CLASS_KEY,
    teacherHost: process.env.CM_TEACHER_HOST,
    teacherPort: process.env.CM_PORT ? Number(process.env.CM_PORT) : undefined,
  };
  const merged: Partial<StudentConfig> = { ...readJson(userConfigPath(userDataDir)) };
  for (const layer of [readJson(systemConfigPath()), env]) {
    for (const [key, value] of Object.entries(layer)) if (value !== undefined && value !== '') Object.assign(merged, { [key]: value });
  }
  if (!merged.classKey) return null;
  return {
    room: merged.room?.trim() || 'Classroom',
    classKey: merged.classKey,
    teacherHost: merged.teacherHost?.trim() || undefined,
    teacherPort: Number(merged.teacherPort) || CONTROL_PORT,
    displayName: merged.displayName?.trim() || undefined,
  };
}
