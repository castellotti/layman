/**
 * Offline IP geolocation for the Map: a local MaxMind-format file
 * the user downloaded and pointed Settings at (DB-IP "IP to City Lite" is the
 * suggestion: CC BY 4.0, no account). Layman ships no database and never asks
 * a service where an IP is — that would tell someone what the sandboxed agent
 * browsed (the rule in docs/extensions/glove.md → Network). A missing or
 * unreadable file just means every destination is in "Unknown location".
 *
 * Who may be looked up is decided by the store, not here: only a destination
 * IP glove resolved inside the tunnel (or that was a literal), never a local
 * link, and never the exit (its coordinates come from exit.ndjson).
 */
import { readFileSync, statSync } from 'fs';
import { Reader, type Response } from 'mmdb-lib';
import { toHostPath } from './discovery.js';
import type { GeoPoint, GeoStatus } from './types.js';

/** IPs cached per loaded database. Bounded: a long session sees many CDN addresses. */
const CACHE_MAX = 20_000;

interface CityResponse {
  city?: { names?: Record<string, string> };
  country?: { iso_code?: string; names?: Record<string, string> };
  registered_country?: { iso_code?: string; names?: Record<string, string> };
  location?: { latitude?: number; longitude?: number };
}

export class GeoLocator {
  private reader: Reader<Response> | null = null;
  private sig: string | null = null;
  private path = '';
  private state: GeoStatus = { configured: false, path: '', displayPath: '', loaded: false, databaseType: null, buildDate: null, error: null, attribution: null };
  private readonly cache = new Map<string, GeoPoint | null>();

  /** `getPath` returns the expanded path, or '' when none is configured. */
  constructor(private readonly getPath: () => string) {}

  /** Re-open the file when the setting or the file changed. True when lookups may now differ. */
  refresh(): boolean {
    const path = this.getPath();
    let sig = path ? 'missing' : 'none';
    if (path) {
      try {
        const st = statSync(path);
        sig = `${st.ino}:${st.mtimeMs}:${st.size}`;
      } catch {
        sig = 'missing';
      }
    }
    if (path === this.path && sig === this.sig) return false;
    this.path = path;
    this.sig = sig;
    this.cache.clear();
    this.reader = null;
    const base = { configured: path !== '', path, displayPath: path ? toHostPath(path) : '', databaseType: null, buildDate: null, attribution: null };
    if (!path) {
      this.state = { ...base, loaded: false, error: null };
      return true;
    }
    if (sig === 'missing') {
      this.state = { ...base, loaded: false, error: 'file not found' };
      return true;
    }
    try {
      const reader = new Reader<Response>(readFileSync(path));
      const m = reader.metadata;
      this.reader = reader;
      const dbip = /dbip|db-ip/i.test(m.databaseType) || /db-ip/i.test(JSON.stringify(m.description ?? ''));
      this.state = {
        ...base,
        loaded: true,
        error: null,
        databaseType: m.databaseType,
        buildDate: m.buildEpoch instanceof Date && !Number.isNaN(m.buildEpoch.getTime()) ? m.buildEpoch.toISOString().slice(0, 10) : null,
        // CC BY 4.0 requires the credit wherever DB-IP data is shown.
        attribution: dbip ? 'IP geolocation by DB-IP' : `IP geolocation: ${m.databaseType}`,
      };
    } catch (e) {
      this.state = { ...base, loaded: false, error: `not a readable MaxMind-format database: ${(e as Error).message}` };
    }
    return true;
  }

  status(): GeoStatus {
    return this.state;
  }

  /** Where an IP is, or null. Never throws: an odd address is just unknown. */
  lookup(ip: string): GeoPoint | null {
    if (!this.reader) return null;
    if (this.cache.has(ip)) return this.cache.get(ip)!;
    let point: GeoPoint | null = null;
    try {
      const r = this.reader.get(ip) as CityResponse | null;
      const lat = r?.location?.latitude;
      const lon = r?.location?.longitude;
      if (r && typeof lat === 'number' && typeof lon === 'number') {
        const country = r.country ?? r.registered_country;
        point = {
          lat, lon,
          city: r.city?.names?.en ?? null,
          country: country?.names?.en ?? null,
          countryCode: country?.iso_code ?? null,
        };
      }
    } catch {
      point = null;
    }
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(ip, point);
    return point;
  }
}
