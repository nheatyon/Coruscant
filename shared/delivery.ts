import type { AcceptedDateContext, PairDateComparison } from './material.js';
import type { ValidationResult } from './workflow.js';

export interface RecordDeliveryInput { note: string }
/** Historical workflow fact. It grants no current material or finding access. */
export interface DeliveryProjection {
  id: string; requestId: string; organizationId: string; resultId: string; scheduleId: string;
  note: string; actorId: string; actorName: string; occurredAt: string; requestVersion: number;
}
/** Server-produced immutable proof captured only at successful delivery finalization. */
export interface DeliveryReadinessSnapshot {
  requestId: string; organizationId: string; resultId: string; scheduleId: string; acceptedQuoteId: string;
  briefRevision: number; materialVersion: number; accessVersion: number; checkedAt: string;
  acceptedContext: AcceptedDateContext; dateComparison: PairDateComparison;
  images: { assetId: string; contentVersion: number; contentHash: string; imageReviewId: string }[];
  finding: { findingId: string; contentVersion: number; findingReviewId: string };
  rights: { licence: string; permittedUse: string; rightsExpiresAt: string | null };
  fileChecks: 'AVAILABLE'; intendedMembershipConfirmed: true;
}
export interface DeliveryPayloads { recordDelivery: RecordDeliveryInput }
export type DeliveryCommandName = keyof DeliveryPayloads;
export interface DeliveryConfirmation { deliveryNote?: string }
export interface DeliveryOutcomeFields { deliveryId?: string }

export function validateDeliveryNote(input: unknown): ValidationResult<RecordDeliveryInput> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { fieldErrors: { note: 'Write the customer-visible delivery note.' } };
  const note = (input as Record<string, unknown>).note;
  if (typeof note !== 'string' || !note.trim()) return { fieldErrors: { note: 'Write a nonblank customer-visible delivery note.' } };
  if (note.length > 4000) return { fieldErrors: { note: 'Use at most 4000 characters.' } };
  return { fieldErrors: {}, value: { note } };
}
