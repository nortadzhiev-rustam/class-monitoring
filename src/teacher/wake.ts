// Wake-on-LAN: a "magic packet" (6 x 0xFF, then the MAC address 16 times)
// broadcast on the local network turns on a sleeping or powered-off PC whose
// network card has Wake-on-LAN enabled.

import dgram from 'node:dgram';
import os from 'node:os';

const MAC = /^([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})$/i;

export function magicPacket(mac: string): Buffer {
  const match = MAC.exec(mac.trim());
  if (!match) throw new Error(`not a MAC address: ${mac}`);
  const address = Buffer.from(match.slice(1).map((byte) => parseInt(byte, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array<Buffer>(16).fill(address)]);
}

function broadcastAddresses(): string[] {
  const targets = new Set(['255.255.255.255']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      targets.add(ip.map((octet, i) => (octet | (~mask[i] & 255)) & 255).join('.'));
    }
  }
  return [...targets];
}

/** Sends magic packets for every MAC; resolves to how many packets went out. */
export function wake(macs: string[], port = Number(process.env.CM_WOL_PORT) || 9): Promise<number> {
  const packets = macs.flatMap((mac) => {
    try {
      return [magicPacket(mac)];
    } catch {
      return [];
    }
  });
  if (!packets.length) return Promise.resolve(0);
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', () => {});
    socket.bind(() => {
      socket.setBroadcast(true);
      const targets = broadcastAddresses();
      let pending = packets.length * targets.length;
      for (const packet of packets) {
        for (const target of targets) {
          socket.send(packet, port, target, () => {
            if (--pending === 0) {
              socket.close();
              resolve(packets.length);
            }
          });
        }
      }
    });
  });
}
