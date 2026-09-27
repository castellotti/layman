/**
 * A minimal MaxMind DB (MMDB v2) *writer*, for tests and the replay script's
 * demo map only. Layman ships no geolocation database (plan §5.4): the user
 * points Settings at one they downloaded. To test the reader without one, this
 * writes a tiny IPv4 database in the real format, with records shaped like
 * DB-IP "IP to City Lite" / GeoLite2-City (`city.names.en`, `country.iso_code`,
 * `country.names.en`, `location.latitude/longitude`).
 *
 * Format: https://maxmind.github.io/MaxMind-DB/ — a binary search tree over the
 * address bits (24-bit records here), 16 zero bytes, a data section of typed
 * values, then the metadata marker and a metadata map.
 */

export interface CityRecord {
  city: string | null;
  countryCode: string;
  country: string;
  lat: number;
  lon: number;
}

type Value = string | number | { double: number } | { u64: number } | Value[] | { [k: string]: Value };

function control(type: number, size: number): Buffer {
  const ext = type > 7;
  const t = ext ? 0 : type;
  const bytes: number[] = [];
  let sizeBits: number;
  const extra: number[] = [];
  if (size < 29) sizeBits = size;
  else if (size < 29 + 256) { sizeBits = 29; extra.push(size - 29); }
  else if (size < 285 + 65536) { sizeBits = 30; const v = size - 285; extra.push(v >> 8, v & 0xff); }
  else { sizeBits = 31; const v = size - 65821; extra.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff); }
  bytes.push((t << 5) | sizeBits);
  if (ext) bytes.push(type - 7);
  return Buffer.from([...bytes, ...extra]);
}

function uintBytes(n: number): Buffer {
  const out: number[] = [];
  let v = BigInt(n);
  while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  return Buffer.from(out);
}

function encode(v: Value): Buffer {
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([control(2, b.length), b]);
  }
  if (typeof v === 'number') {
    // Unsigned integers: uint16 or uint32 by size, as the spec's writers do.
    const b = uintBytes(v);
    return Buffer.concat([control(v <= 0xffff ? 5 : 6, b.length), b]);
  }
  if (Array.isArray(v)) return Buffer.concat([control(11, v.length), ...v.map(encode)]);
  if ('double' in v && typeof v.double === 'number') {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v.double);
    return Buffer.concat([control(3, 8), b]);
  }
  if ('u64' in v && typeof v.u64 === 'number') {
    const b = uintBytes(v.u64);
    return Buffer.concat([control(9, b.length), b]);
  }
  const entries = Object.entries(v as Record<string, Value>);
  return Buffer.concat([control(7, entries.length), ...entries.flatMap(([k, x]) => [encode(k), encode(x)])]);
}

function cityValue(r: CityRecord): Value {
  return {
    ...(r.city ? { city: { names: { en: r.city } } } : {}),
    country: { iso_code: r.countryCode, names: { en: r.country } },
    location: { latitude: { double: r.lat }, longitude: { double: r.lon } },
  };
}

function ipv4(s: string): number {
  const p = s.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** Build an IPv4 database mapping each CIDR to a city record. */
export function writeMmdb(entries: Array<{ cidr: string; record: CityRecord }>, databaseType = 'Layman-Test-City'): Buffer {
  // A binary trie over the address bits; leaves point at data.
  type Node = [number | Node | null, number | Node | null];
  const root: Node = [null, null];
  const data: Buffer[] = [];
  const dataOffsets: number[] = [];
  let dataSize = 0;
  for (const e of entries) {
    const [ip, lenS] = e.cidr.split('/');
    const len = lenS === undefined ? 32 : Number(lenS);
    const value = encode(cityValue(e.record));
    dataOffsets.push(dataSize);
    data.push(value);
    dataSize += value.length;
    const bits = ipv4(ip);
    let node = root;
    for (let i = 0; i < len; i++) {
      const bit = (bits >>> (31 - i)) & 1;
      if (i === len - 1) {
        node[bit] = dataOffsets.length - 1;
      } else {
        let next = node[bit];
        if (typeof next !== 'object' || next === null) {
          next = [null, null];
          node[bit] = next;
        }
        node = next;
      }
    }
  }
  // Number the nodes breadth-first.
  const nodes: Node[] = [];
  const index = new Map<Node, number>();
  const queue: Node[] = [root];
  while (queue.length) {
    const n = queue.shift()!;
    index.set(n, nodes.length);
    nodes.push(n);
    for (const c of n) if (c && typeof c === 'object') queue.push(c);
  }
  const nodeCount = nodes.length;
  const record = (r: number | Node | null): number => {
    if (r === null) return nodeCount; // "no data"
    if (typeof r === 'number') return nodeCount + 16 + dataOffsets[r];
    return index.get(r)!;
  };
  const tree = Buffer.alloc(nodeCount * 6);
  nodes.forEach((n, i) => {
    tree.writeUIntBE(record(n[0]), i * 6, 3);
    tree.writeUIntBE(record(n[1]), i * 6 + 3, 3);
  });
  const metadata = encode({
    node_count: nodeCount,
    record_size: 24,
    ip_version: 4,
    database_type: databaseType,
    languages: ['en'],
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: { u64: Math.floor(Date.UTC(2026, 8, 1) / 1000) },
    description: { en: 'Layman test database: not real geolocation data' },
  });
  return Buffer.concat([
    tree, Buffer.alloc(16), ...data,
    Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com', 'ascii'), metadata,
  ]);
}
