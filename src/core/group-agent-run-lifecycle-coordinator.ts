export class GroupAgentRunLifecycleCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(
    scopeKey: string,
    accountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${scopeKey.length}:${scopeKey}${accountId}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
