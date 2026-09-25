/** Shared fixtures for the network-view unit tests (not a test file itself). */
import type { NetGateView } from './netobs-types.js';

/** A healthy, fresh gate on a verified VPN route: the glove fixture session. */
export const gate = (over: Partial<NetGateView> = {}): NetGateView => ({
  freshness: 'running', state: 'running', gateVersion: '0.1.0', heartbeatAgeMs: 2000, record: 'metadata',
  route: { kind: 'vpn', verified: true, exitIdentityOff: false, upstreamHealthy: true },
  resolver: { mode: 'in-tunnel', healthy: true, name: 'dns://gluetun:53' },
  rules: { loaded_at: '2026-09-23T14:14:47.630Z', source_mtime: null, ok: true, error: null, active_count: 1 },
  telemetry: { written: 83, dropped: 0, invalid: 0, rotations: 0 }, unwatchedServices: [], ...over,
});
