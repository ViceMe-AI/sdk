import { describe, expect, it, vi } from 'vitest';
import { Lifecycle } from '../../src/core/lifecycle.ts';
import { ViceMeError, clientDestroyed } from '../../src/core/errors.ts';

describe('Lifecycle', () => {
  it('follows the happy CREATED -> READY -> DESTROYED path', () => {
    const life = new Lifecycle();
    const seen: string[] = [];
    life.subscribe((s) => seen.push(s));

    expect(life.state).toBe('CREATED');
    expect(life.destroyed).toBe(false);

    life.transition('INITIALIZING');
    life.transition('READY');
    life.transition('DESTROYED');

    expect(life.state).toBe('DESTROYED');
    expect(life.destroyed).toBe(true);
    expect(seen).toEqual(['INITIALIZING', 'READY', 'DESTROYED']);
  });

  it('rejects illegal transitions', () => {
    const life = new Lifecycle();
    expect(() => life.transition('READY')).toThrow(ViceMeError);
    life.transition('INITIALIZING');
    expect(() => life.transition('READY')).not.toThrow();
    expect(() => life.transition('INITIALIZING')).toThrow(ViceMeError);
  });

  it('supports FAILED -> INITIALIZING retry', () => {
    const life = new Lifecycle();
    life.transition('INITIALIZING');
    life.transition('FAILED');
    expect(() => life.transition('INITIALIZING')).not.toThrow();
  });

  it('assertAlive throws CLIENT_DESTROYED once destroyed', () => {
    const life = new Lifecycle();
    life.transition('DESTROYED');
    expect(() => life.assertAlive()).toThrow(clientDestroyed());
  });

  it('unsubscribe stops further notifications', () => {
    const life = new Lifecycle();
    const fn = vi.fn();
    const off = life.subscribe(fn);
    off();
    life.transition('INITIALIZING');
    expect(fn).not.toHaveBeenCalled();
  });
});
