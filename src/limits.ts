/**
 * In-memory limiters for the hosted server. They are per pod: with N replicas a
 * tenant's effective allowance is up to N times the configured one. That is
 * deliberate; it keeps the server stateless, and the limits exist to stop abuse
 * and runaway agents, not to meter usage.
 */

type Clock = () => number;

interface Entry {
  count: number;
  resetAt: number;
}

/** Fixed-window counter keyed by an arbitrary string, with a bounded footprint. */
export class WindowLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxEntries = 50_000,
    private readonly now: Clock = Date.now,
  ) {}

  /** Seconds until `key` may act again, or null if it is under the limit. Records nothing. */
  retryAfter(key: string): number | null {
    const entry = this.live(key);

    if (!entry || entry.count < this.limit) {
      return null;
    }

    return Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  /** Records one hit. Returns seconds to wait if this hit is over the limit, else null. */
  hit(key: string): number | null {
    const entry = this.live(key) ?? this.insert(key);

    entry.count += 1;

    return entry.count > this.limit ? Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000)) : null;
  }

  /** Drops expired entries. Called on a timer so idle keys do not linger. */
  sweep(): void {
    const now = this.now();

    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);

    if (entry && entry.resetAt <= this.now()) {
      this.entries.delete(key);

      return undefined;
    }

    return entry;
  }

  private insert(key: string): Entry {
    if (this.entries.size >= this.maxEntries) {
      this.sweep();
    }

    // Still full of live entries: evict the oldest rather than grow without bound
    // (an attacker rotating keys or addresses must not be able to exhaust memory).
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;

      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }

    const entry = { count: 0, resetAt: this.now() + this.windowMs };

    this.entries.set(key, entry);

    return entry;
  }
}

/** Caps simultaneous in-flight requests per key. */
export class ConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  constructor(private readonly limit: number) {}

  /** A release function, or null if `key` is already at its limit. Release exactly once. */
  acquire(key: string): (() => void) | null {
    const current = this.active.get(key) ?? 0;

    if (current >= this.limit) {
      return null;
    }

    this.active.set(key, current + 1);

    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;

      const remaining = (this.active.get(key) ?? 1) - 1;

      if (remaining <= 0) {
        this.active.delete(key);
      } else {
        this.active.set(key, remaining);
      }
    };
  }

  get inFlight(): number {
    let total = 0;

    for (const count of this.active.values()) {
      total += count;
    }

    return total;
  }
}
