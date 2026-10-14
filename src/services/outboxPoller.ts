import { withTransaction } from '../db/transaction.js';
import { lockUnpublishedEvents, markEventsPublished } from '../repositories/outbox.js';
import { deliverToShipping } from './deliveryConsumer.js';
import type { Deps, Logger } from './types.js';

const BATCH_SIZE = 50;

export async function publishOutbox(deps: Deps, log: Logger): Promise<void> {
  const published = await withTransaction(deps.pool, async (tx) => {
    const events = await lockUnpublishedEvents(tx, BATCH_SIZE);
    const delivered: string[] = [];
    for (const event of events) {
      try {
        await deliverToShipping(event, log);
        delivered.push(event.id);
      } catch (err) {
        log.error({ err, eventId: event.id }, 'outbox delivery failed; will retry');
      }
    }
    if (delivered.length > 0) {
      await markEventsPublished(tx, delivered);
    }
    return delivered.length;
  });

  if (published > 0) {
    log.info({ published }, 'outbox events published');
  }
}
