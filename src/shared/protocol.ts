// Messages exchanged between the teacher console and student agents.
// Everything after the handshake travels inside a SecureChannel (see secure-channel.ts).

export const APP_ID = 'class-monitor';
/** Teacher and students must match; bump on any incompatible message change. */
export const PROTOCOL_VERSION = 2;
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
  /** Network adapter MAC addresses, for Wake-on-LAN. */
  macs: string[];
  version: string;
}

/**
 * Everything the teacher has switched on for one student. Sent whole whenever it
 * changes (and on connect), so a student that reconnects or joins late ends up
 * in the same state as the rest of its class.
 */
export interface Policy {
  /** Lock-screen message, or null when unlocked. */
  lock: string | null;
  /** Teacher's screen-broadcast session the student should show, or null. */
  broadcast: string | null;
  /** The poll the student should be answering, or null. */
  poll: Poll | null;
}

export const OPEN_POLICY: Policy = { lock: null, broadcast: null, poll: null };

export interface Poll {
  pollId: string;
  question: string;
  choices: string[];
}

export const LIMITS = {
  message: 2000,
  chat: 2000,
  handNote: 200,
  pollQuestion: 300,
  pollChoice: 60,
  pollChoices: 6,
} as const;

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
  | { type: 'policy'; policy: Policy }
  | { type: 'thumb-config'; intervalMs: number; width: number }
  | { type: 'view-start'; sessionId: string }
  | { type: 'view-stop'; sessionId: string }
  | { type: 'control'; sessionId: string; enabled: boolean; teacherPlatform: Platform }
  | { type: 'input'; sessionId: string; events: InputEvent[] }
  | { type: 'signal'; sessionId: string; signal: RtcSignal }
  | { type: 'message'; id: string; text: string }
  | { type: 'chat'; id: string; text: string; at: number }
  /** The teacher has dealt with the student's raised hand. */
  | { type: 'hand-clear' };

export type StudentMessage =
  | { type: 'info'; info: StudentInfo }
  /** `hand` is the help note while the student's hand is raised ('' for no note), else null. */
  | { type: 'status'; locked: boolean; viewing: boolean; controlled: boolean; hand: string | null }
  /** Sent with a JPEG payload. */
  | { type: 'thumb'; width: number; height: number }
  | { type: 'broadcast-ready'; sessionId: string }
  | { type: 'signal'; sessionId: string; signal: RtcSignal }
  | { type: 'chat'; id: string; text: string; at: number }
  | { type: 'poll-answer'; pollId: string; choice: number }
  | { type: 'error'; sessionId?: string; message: string };
