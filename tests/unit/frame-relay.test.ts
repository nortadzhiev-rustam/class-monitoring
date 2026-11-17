import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameRelay, MAX_QUEUED_BYTES, type ViewerLink } from '../../src/shared/frame-relay';
import type { TeacherMessage } from '../../src/shared/protocol';

/** A fake student connection that records what it was sent. */
function fakeLink() {
  const sent: Array<{ msg: TeacherMessage; payload: Buffer }> = [];
  const link: ViewerLink<TeacherMessage> & { queued: number; isOpen: boolean } = {
    queued: 0,
    isOpen: true,
    send: (msg, payload) => void sent.push({ msg, payload }),
    buffered: () => link.queued,
    open: () => link.isOpen,
  };
  return { link, sent, keys: () => sent.map((s) => (s.msg.type === 'broadcast-frame' && s.msg.key ? 'K' : 'd')).join('') };
}

function setup(ids: string[]) {
  const links = new Map(ids.map((id) => [id, fakeLink()]));
  const events = { keyframes: 0, viewers: [] as number[] };
  const relay = new FrameRelay<TeacherMessage>(
    (id) => links.get(id)?.link ?? null,
    { keyframe: () => events.keyframes++, viewers: (count) => events.viewers.push(count) },
    (sessionId, meta) => ({ type: 'broadcast-frame', sessionId, ...meta }),
  );
  return { relay, links, events };
}

const key = { codec: 'avc1.640028', key: true, timestamp: 0 };
const delta = { codec: 'avc1.640028', key: false, timestamp: 1 };
const data = Buffer.from([0, 0, 0, 1, 0x65]);

test('one encoded frame goes to every student watching, unchanged', () => {
  const { relay, links } = setup(['a', 'b', 'c']);
  relay.start('s1');
  for (const id of ['a', 'b', 'c']) relay.ready(id, 's1');
  relay.frame('s1', key, data);
  relay.frame('s1', delta, data);
  for (const { sent, keys } of links.values()) {
    assert.equal(keys(), 'Kd');
    assert.deepEqual(sent[0].msg, { type: 'broadcast-frame', sessionId: 's1', ...key });
    assert.equal(sent[0].payload, data);
  }
});

test('a student who joins mid-stream waits for a keyframe and asks for one', () => {
  const { relay, links, events } = setup(['a', 'late']);
  relay.start('s1');
  relay.ready('a', 's1');
  relay.frame('s1', key, data);
  relay.frame('s1', delta, data);
  const before = events.keyframes;
  relay.ready('late', 's1');
  assert.equal(events.keyframes, before + 1);
  relay.frame('s1', delta, data);
  relay.frame('s1', key, data);
  relay.frame('s1', delta, data);
  assert.equal(links.get('a')!.keys(), 'KddKd');
  assert.equal(links.get('late')!.keys(), 'Kd');
});

test('a backed-up student skips frames and resumes at a keyframe once caught up, without holding back others', () => {
  const { relay, links, events } = setup(['fast', 'slow']);
  relay.start('s1');
  relay.ready('fast', 's1');
  relay.ready('slow', 's1');
  relay.frame('s1', key, data);
  const slow = links.get('slow')!;
  slow.link.queued = MAX_QUEUED_BYTES + 1;
  relay.frame('s1', delta, data);
  relay.frame('s1', delta, data);
  const asked = events.keyframes;
  // Still backed up: no point asking for a keyframe yet.
  relay.frame('s1', delta, data);
  assert.equal(events.keyframes, asked);
  // Caught up: it can't use a delta frame, so it asks for a keyframe.
  slow.link.queued = 0;
  relay.frame('s1', delta, data);
  assert.equal(events.keyframes, asked + 1);
  relay.frame('s1', key, data);
  relay.frame('s1', delta, data);
  assert.equal(links.get('fast')!.keys(), 'KddddKd');
  assert.equal(slow.keys(), 'KKd');
});

test('a student who reports ready again (after a decoding error) restarts from a keyframe', () => {
  const { relay, links, events } = setup(['a']);
  relay.start('s1');
  relay.ready('a', 's1');
  relay.frame('s1', key, data);
  relay.ready('a', 's1');
  relay.frame('s1', delta, data);
  relay.frame('s1', key, data);
  assert.equal(links.get('a')!.keys(), 'KK');
  assert.deepEqual(events.viewers, [0, 1], 'the same student is counted once');
});

test('frames and readiness for another session are ignored; stop sends nothing more', () => {
  const { relay, links, events } = setup(['a']);
  relay.ready('a', 's1');
  relay.frame('s1', key, data);
  relay.start('s2');
  relay.ready('a', 's1');
  relay.frame('s1', key, data);
  assert.equal(links.get('a')!.sent.length, 0);
  relay.ready('a', 's2');
  relay.frame('s2', key, data);
  relay.stop();
  relay.frame('s2', key, data);
  relay.ready('a', 's2');
  assert.equal(links.get('a')!.keys(), 'K');
  assert.equal(events.keyframes, 1);
});

test('viewer counts follow students joining and leaving; closed connections get nothing', () => {
  const { relay, links, events } = setup(['a', 'b']);
  relay.start('s1');
  relay.ready('a', 's1');
  relay.ready('b', 's1');
  links.get('b')!.link.isOpen = false;
  relay.frame('s1', key, data);
  assert.equal(links.get('b')!.sent.length, 0);
  relay.left('b');
  relay.left('nobody');
  assert.deepEqual(events.viewers, [0, 1, 2, 1]);
  assert.equal(relay.count, 1);
});
