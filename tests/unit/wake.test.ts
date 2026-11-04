import assert from 'node:assert/strict';
import { test } from 'node:test';
import { magicPacket } from '../../src/teacher/wake';

test('a magic packet is six 0xFF bytes then the MAC sixteen times', () => {
  const packet = magicPacket('AA:bb:01:02:03:04');
  assert.equal(packet.length, 102);
  assert.deepEqual([...packet.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  for (let i = 0; i < 16; i++) assert.deepEqual([...packet.subarray(6 + i * 6, 12 + i * 6)], [0xaa, 0xbb, 1, 2, 3, 4]);
});

test('dash-separated MACs work and junk is refused', () => {
  assert.equal(magicPacket('aa-bb-cc-dd-ee-ff').length, 102);
  assert.throws(() => magicPacket('not-a-mac'));
  assert.throws(() => magicPacket('aa:bb:cc:dd:ee'));
});
