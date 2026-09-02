/** Injectable time source — nothing in the system may call Date.now() directly. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Test double — the debounce scheduler tests depend on controlling time. */
export class FakeClock implements Clock {
  constructor(private t: number) {}

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  set(ms: number): void {
    this.t = ms;
  }
}
