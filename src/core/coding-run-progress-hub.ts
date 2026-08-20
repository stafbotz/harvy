import type { CodingRun } from "../domain/coding-run.js";

export type CodingRunProgressListener = (run: CodingRun) => void | Promise<void>;

/** Process-local delivery fan-out; durable CodingRun remains the source of truth. */
export class CodingRunProgressHub {
  readonly #listeners = new Map<string, Set<CodingRunProgressListener>>();
  readonly #latest = new Map<string, CodingRun>();

  subscribe(runId: string, listener: CodingRunProgressListener): () => void {
    const listeners = this.#listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => {
      const current = this.#listeners.get(runId);
      current?.delete(listener);
      if (current?.size === 0) this.#listeners.delete(runId);
    };
  }

  async report(run: CodingRun): Promise<void> {
    this.#latest.set(run.runId, structuredClone(run));
    const listeners = [...(this.#listeners.get(run.runId) ?? [])];
    await Promise.allSettled(
      listeners.map((listener) => Promise.resolve(listener(structuredClone(run)))),
    );
  }

  latest(runId: string): CodingRun | null {
    const run = this.#latest.get(runId);
    return run ? structuredClone(run) : null;
  }
}
