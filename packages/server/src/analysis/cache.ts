import { createHash } from 'crypto';
import type { AnalysisResult } from './types.js';

interface CacheEntry {
  result: AnalysisResult;
  timestamp: number;
  hits: number;
}

export class AnalysisCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries: number;
  private ttlMs: number;

  constructor(maxEntries = 200, ttlMs = 3600000) {
    // Default TTL: 1 hour
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  private makeKey(toolName: string, toolInput: unknown, depth: string): string {
    const raw = `${toolName}:${JSON.stringify(toolInput)}:${depth}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  get(toolName: string, toolInput: unknown, depth: string): AnalysisResult | undefined {
    const key = this.makeKey(toolName, toolInput, depth);
    const entry = this.cache.get(key);

    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    entry.hits++;
    return entry.result;
  }

  set(toolName: string, toolInput: unknown, depth: string, result: AnalysisResult): void {
    const key = this.makeKey(toolName, toolInput, depth);

    // LRU eviction: remove oldest entry if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const oldestKey = this.findOldestKey();
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      hits: 0,
    });
  }

  private findOldestKey(): string | undefined {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
