import type { ValidationResult } from './workflow.js';

/** Coordinates belong to the exact oriented image version named by the command target. */
export interface ObservationInput { x: number; y: number; text: string }
export interface ObservationProjection extends ObservationInput {
  id: string; resultId: string; organizationId: string; assetId: string; contentVersion: number;
  authorId: string; authorName: string; version: number; createdAt: string; updatedAt: string; canEdit: boolean;
}
export interface ObservationPayloads {
  createObservation: { observation: ObservationInput };
  updateObservation: { observation: ObservationInput };
  deleteObservation: Record<string, never>;
}
export type ObservationCommandName = keyof ObservationPayloads;
export interface ObservationTarget { observationId?: string }
export interface ObservationExpected { observationVersion?: number }
export interface ObservationOutcomeFields { observationId?: string; observationVersion?: number }

/** This validates content, never client-supplied authorship, role or image authority. */
export function validateObservation(input: unknown): ValidationResult<ObservationInput> {
  const errors: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { fieldErrors: { observation: 'Provide a point and note for this exact image version.' } };
  const row = input as Record<string, unknown>;
  for (const field of ['x', 'y'] as const) {
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0 || row[field] > 1) errors[field] = 'Choose an image coordinate from 0 to 1.';
  }
  if (typeof row.text !== 'string') errors.text = 'Enter a note.';
  else if (!row.text.trim()) errors.text = 'Enter a nonblank note.';
  else if (row.text.length > 2000) errors.text = 'Use at most 2000 characters.';
  return Object.keys(errors).length ? { fieldErrors: errors } : { fieldErrors: {}, value: { x: row.x as number, y: row.y as number, text: row.text as string } };
}
