// Disposable E2E runner only. No credentials, process lists, socket addresses or
// connection payloads are returned. This observes contention, never frees a port.
import { readFileSync } from 'node:fs';
import { connectorRefreshLockPort } from '../mcp/dist/refresh-coordination.js';

const ports = ['charity', 'operator'].map(realm => ({ realm,
  port: connectorRefreshLockPort('http://127.0.0.1:3302', realm) }));
const result = { platform: process.platform, ephemeralRange: null, ports,
  sockets: { available: false, counts: [] } };
if (process.platform === 'linux') {
  try {
    const values = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
    if (values.length === 2 && values.every(v => Number.isInteger(v) && v > 0 && v <= 65535)) result.ephemeralRange = values;
  } catch { /* Unavailable is not evidence of no overlap. */ }
  try {
    const counts = new Map();
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      for (const line of readFileSync(file, 'utf8').trim().split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        const port = Number.parseInt(fields[1]?.split(':')[1] ?? '', 16);
        const state = fields[3];
        if (!ports.some(value => value.port === port) || !/^[0-9A-F]{2}$/i.test(state ?? '')) continue;
        const key = `${port}:${state.toUpperCase()}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    result.sockets = { available: true, counts: [...counts].map(([key, count]) => {
      const [port, state] = key.split(':'); return { port: Number(port), state, count };
    }) };
  } catch { /* Keep unavailable; do not turn a partial read into an empty proof. */ }
}
console.log(JSON.stringify(result));
