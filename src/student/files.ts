// Files from the teacher (saved to Documents/ClassMonitor/From teacher) and
// work handed in while the teacher is collecting.

import { app, shell } from 'electron';
import path from 'node:path';
import { FileReceiver, sendFile, type FileLink } from '../shared/file-transfer';
import { pickFiles } from '../shared/native-dialogs';
import type { Collect, FileMessage } from '../shared/protocol';
import type { PromptCard } from './ipc';
import { findPrompt, onPromptAction, removePrompt, removePrompts, showPrompt } from './prompts';
import { send, state } from './state';

type CollectCard = Extract<PromptCard, { kind: 'collect' }>;

const receiver = new FileReceiver();
/** Uploads waiting for the teacher's acknowledgement: transferId -> card and file name. */
const uploads = new Map<string, { cardId: string; name: string }>();

const baseDir = () => process.env.CM_FILES_DIR ?? path.join(app.getPath('documents'), 'ClassMonitor');

const link: FileLink = {
  send: (msg, payload) => send(msg, payload),
  buffered: () => state.link?.bufferedAmount ?? 0,
  open: () => state.link?.connected ?? false,
};

const ack = (transferId: string, ok: boolean, error?: string) => send({ type: 'file-ack', transferId, ok, ...(error ? { error } : {}) });

export function handleFileMessage(msg: FileMessage, payload: Buffer | undefined): void {
  switch (msg.type) {
    case 'file-start': {
      const error = receiver.start(msg, path.join(baseDir(), 'From teacher'));
      if (error) ack(msg.transferId, false, error);
      break;
    }
    case 'file-chunk': {
      if (!receiver.has(msg.transferId)) return;
      const error = receiver.chunk(msg, payload);
      if (error) ack(msg.transferId, false, error);
      break;
    }
    case 'file-end': {
      const result = receiver.end(msg);
      if ('error' in result) {
        ack(msg.transferId, false, result.error);
        return;
      }
      ack(msg.transferId, true);
      showPrompt({ id: `file-${msg.transferId}`, kind: 'file', from: state.teacher?.name ?? 'Your teacher', name: result.name, path: result.path });
      break;
    }
    case 'file-ack':
      uploadAcknowledged(msg.transferId, msg.ok, msg.error);
      break;
  }
}

/** Connection lost: discard half-received files and forget pending uploads. */
export function resetFiles(): void {
  receiver.abortAll();
  uploads.clear();
}

onPromptAction('file', (card, action) => {
  if (card.kind !== 'file') return;
  if (action === 'open') void shell.openPath(card.path);
  else if (action === 'folder') shell.showItemInFolder(card.path);
  else if (action === 'dismiss') removePrompt(card.id);
});

// ---------------------------------------------------------------- collecting work

/** Shows or clears the "hand in" card to match the teacher's policy. */
export function showCollect(collect: Collect | null): void {
  removePrompts((c) => c.kind === 'collect' && c.collectId !== collect?.collectId);
  if (!collect || findPrompt(`collect-${collect.collectId}`)) return;
  showPrompt({
    id: `collect-${collect.collectId}`,
    kind: 'collect',
    collectId: collect.collectId,
    title: collect.title,
    from: state.teacher?.name ?? 'Your teacher',
    handedIn: [],
    sending: [],
    error: null,
  });
}

function updateCollect(cardId: string, change: (card: CollectCard) => Partial<CollectCard>): void {
  const card = findPrompt(cardId);
  if (card?.kind === 'collect') showPrompt({ ...card, ...change(card) });
}

onPromptAction('collect', (card, action) => {
  if (card.kind !== 'collect' || action !== 'choose') return;
  void handIn(card);
});

async function handIn(card: CollectCard): Promise<void> {
  const files = await pickFiles(null, `Hand in: ${card.title}`);
  for (const file of files) {
    const name = path.basename(file);
    updateCollect(card.id, (c) => ({ sending: [...c.sending, name], error: null }));
    try {
      const { transferId } = await sendFile(link, file, { collectId: card.collectId });
      uploads.set(transferId, { cardId: card.id, name });
    } catch (err) {
      updateCollect(card.id, (c) => ({ sending: c.sending.filter((n) => n !== name), error: `${name}: ${(err as Error).message}` }));
    }
  }
}

function uploadAcknowledged(transferId: string, ok: boolean, error?: string): void {
  const upload = uploads.get(transferId);
  if (!upload) return;
  uploads.delete(transferId);
  updateCollect(upload.cardId, (c) => ({
    sending: c.sending.filter((n) => n !== upload.name),
    handedIn: ok ? [...c.handedIn, upload.name] : c.handedIn,
    error: ok ? null : `${upload.name} wasn't handed in: ${String(error ?? 'unknown error').slice(0, 200)}`,
  }));
}
