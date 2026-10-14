import type { OutboxEvent } from '../repositories/outbox.js';
import { ORDER_PAID } from './orderEvents.js';
import type { Logger } from './types.js';

export async function deliverToShipping(event: OutboxEvent, log: Logger): Promise<void> {
  if (event.type !== ORDER_PAID) {
    log.info({ eventId: event.id, type: event.type }, 'delivery consumer ignored event');
    return;
  }
  log.info(
    { eventId: event.id, orderId: event.aggregateId, payload: event.payload },
    'delivery consumer: shipment requested',
  );
}
