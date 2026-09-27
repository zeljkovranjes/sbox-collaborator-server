/** Serialises async work per key (single server instance; the DB adds a lock for multi-instance). */
export class KeyedMutex {
  #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

/** A simple FIFO lock. */
export class Mutex {
  #inner = new KeyedMutex();
  run<T>(work: () => Promise<T>): Promise<T> {
    return this.#inner.run('', work);
  }
}
