import { describe, expect, it } from 'vitest';

import { ConcurrencyLimiter, WindowLimiter } from '../src/limits.js';

function clock(start = 1_000_000) {
  let now = start;

  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe('WindowLimiter', () => {
  it('allows up to the limit, then reports seconds to wait', () => {
    const c = clock();
    const limiter = new WindowLimiter(3, 60_000, 100, c.now);

    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('a')]).toEqual([null, null, null]);
    expect(limiter.hit('a')).toBe(60);
  });

  it('counts each key on its own', () => {
    const limiter = new WindowLimiter(1, 60_000);

    expect(limiter.hit('a')).toBeNull();
    expect(limiter.hit('b')).toBeNull();
    expect(limiter.hit('a')).not.toBeNull();
  });

  it('opens a fresh window once the old one has passed', () => {
    const c = clock();
    const limiter = new WindowLimiter(1, 60_000, 100, c.now);

    limiter.hit('a');
    expect(limiter.hit('a')).not.toBeNull();
    c.advance(60_001);
    expect(limiter.hit('a')).toBeNull();
  });

  it('retryAfter reads without recording', () => {
    const limiter = new WindowLimiter(2, 60_000);

    expect(limiter.retryAfter('a')).toBeNull();
    limiter.hit('a');
    limiter.hit('a');
    expect(limiter.retryAfter('a')).toBeGreaterThan(0);
    expect(limiter.retryAfter('b')).toBeNull();
  });

  it('never grows past its cap, so rotating keys cannot exhaust memory', () => {
    const limiter = new WindowLimiter(5, 60_000, 50);

    for (let i = 0; i < 1000; i++) {
      limiter.hit(`attacker-${i}`);
    }

    expect(limiter.size).toBeLessThanOrEqual(50);
  });

  it('sweeps expired entries', () => {
    const c = clock();
    const limiter = new WindowLimiter(5, 1000, 100, c.now);

    limiter.hit('a');
    limiter.hit('b');
    c.advance(2000);
    limiter.sweep();

    expect(limiter.size).toBe(0);
  });
});

describe('ConcurrencyLimiter', () => {
  it('refuses beyond the limit and frees a slot on release', () => {
    const limiter = new ConcurrencyLimiter(2);
    const first = limiter.acquire('a');
    const second = limiter.acquire('a');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(limiter.acquire('a')).toBeNull();

    first?.();
    expect(limiter.acquire('a')).not.toBeNull();
  });

  it('isolates keys', () => {
    const limiter = new ConcurrencyLimiter(1);

    expect(limiter.acquire('a')).not.toBeNull();
    expect(limiter.acquire('b')).not.toBeNull();
  });

  it('ignores a double release, which would otherwise mint extra capacity', () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = limiter.acquire('a');

    release?.();
    release?.();

    expect(limiter.acquire('a')).not.toBeNull();
    expect(limiter.acquire('a')).toBeNull();
    expect(limiter.inFlight).toBe(1);
  });
});
