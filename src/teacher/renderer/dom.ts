import type { TeacherApi } from '../ipc';

declare global {
  interface Window {
    teacher: TeacherApi;
  }
}

export const api = window.teacher;

export const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;

export const OS_LABEL: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

export function toast(message: string, kind: 'error' | 'info' = 'error'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 7000);
}

/** Strips Electron's "Error invoking remote method ..." wrapper from IPC errors. */
export function errorText(err: unknown): string {
  return (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function timeAgo(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
