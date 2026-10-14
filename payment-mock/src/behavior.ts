export type Behavior = 'APPROVE' | 'DECLINE' | 'RECORD_THEN_HANG' | 'HANG_WITHOUT_RECORDING';

export function behaviorFor(cardNumber: string): Behavior {
  if (cardNumber.startsWith('0000')) return 'DECLINE';
  if (cardNumber.startsWith('1111')) return 'RECORD_THEN_HANG';
  if (cardNumber.startsWith('2222')) return 'HANG_WITHOUT_RECORDING';
  return 'APPROVE';
}
