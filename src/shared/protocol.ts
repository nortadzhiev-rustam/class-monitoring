// Messages exchanged between the teacher console and student agents.
// Everything after the handshake travels inside a SecureChannel (see secure-channel.ts).

export const APP_ID = 'class-monitor';
export const PROTOCOL_VERSION = 1;
/** UDP port students listen on for teacher beacons. */
export const DISCOVERY_PORT = 47800;
/** TCP port the teacher console accepts WebSocket connections on. */
export const CONTROL_PORT = 47801;
export const BEACON_INTERVAL_MS = 2000;

export type Platform = 'darwin' | 'win32' | 'linux';

/** UDP beacon payload broadcast by the teacher console. */
export interface Beacon {
  app: typeof APP_ID;
  v: number;
  room: string;
  port: number;
  teacher: string;
}

export interface StudentInfo {
  id: string;
  hostname: string;
  username: string;
  platform: Platform;
  /** Size of the shared (primary) display in device-independent pixels. */
  screen: { width: number; height: number };
  version: string;
}

export type RtcSignal =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null };

/**
 * Remote-control input. Pointer coordinates are normalised to 0..1 across the
 * student's shared display so the two machines can have different resolutions.
 */
export type InputEvent =
  | { t: 'move'; x: number; y: number }
  | { t: 'button'; button: 0 | 1 | 2; down: boolean; x: number; y: number; clicks: number }
  | { t: 'wheel'; dx: number; dy: number }
  | { t: 'key'; code: string; down: boolean };

export type TeacherMessage =
  | { type: 'welcome'; teacher: string; room: string }
  | { type: 'lock'; message: string }
  | { type: 'unlock' }
  | { type: 'thumb-config'; intervalMs: number; width: number }
  | { type: 'view-start'; sessionId: string }
  | { type: 'view-stop'; sessionId: string }
  | { type: 'control'; sessionId: string; enabled: boolean; teacherPlatform: Platform }
  | { type: 'input'; sessionId: string; events: InputEvent[] }
  | { type: 'broadcast-start'; sessionId: string }
  | { type: 'broadcast-stop'; sessionId: string }
  | { type: 'signal'; sessionId: string; signal: RtcSignal };

export type StudentMessage =
  | { type: 'info'; info: StudentInfo }
  | { type: 'status'; locked: boolean; viewing: boolean; controlled: boolean }
  /** Sent with a JPEG payload. */
  | { type: 'thumb'; width: number; height: number }
  | { type: 'broadcast-ready'; sessionId: string }
  | { type: 'signal'; sessionId: string; signal: RtcSignal }
  | { type: 'error'; sessionId?: string; message: string };
