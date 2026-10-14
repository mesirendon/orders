import type { Logger } from './types.js';

export interface Job {
  stop(): Promise<void>;
}

export function startJob(name: string, intervalMs: number, tick: () => Promise<void>, log: Logger): Job {
  let running: Promise<void> | null = null;

  const timer = setInterval(() => {
    if (running) return;
    running = tick()
      .catch((err) => log.error({ err, job: name }, 'job tick failed'))
      .finally(() => {
        running = null;
      });
  }, intervalMs);

  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
