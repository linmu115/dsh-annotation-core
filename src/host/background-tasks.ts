/** Tracks admitted work so lifecycle cleanup can close its storage last. */
export class BackgroundTasks {
  private readonly active = new Set<Promise<unknown>>()
  private stopped = false

  get closed(): boolean { return this.stopped }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Annotation runtime is stopping'))
    // Register before invoking user adapters; even reentrant disposal sees this work.
    const task = Promise.resolve().then(operation)
    this.active.add(task)
    void task.then(() => this.active.delete(task), () => this.active.delete(task))
    return task
  }

  async dispose(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.active])
  }
}

/** Preserve rejection while waiting for every sibling write, not only the first failure. */
export async function settleAll(tasks: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks)
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
