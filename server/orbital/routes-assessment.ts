import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AssessmentHandle, AssessmentReadInput, AssessmentRecheckInput, AssessmentStartInput, AssessmentPageKind } from '../../shared/plan-contracts.js';
import type { Database } from '../db/database.js';
import { transaction } from '../db/database.js';
import { ApiError, unavailable } from '../errors.js';
import { authorizeRequest, projectRequest, requestRow } from '../projections.js';
import { bodyObject, guardContext, requireOrganization, requireSession, requireStaff, type Clock, type Session } from '../security.js';
import { assessmentOwner, type createAssessmentService } from './assessment-service.js';

type Service = ReturnType<typeof createAssessmentService>;
/** Every assessment carries target data in a guarded JSON body, never a public URL. */
function payload(request: FastifyRequest, keys: string[]): Record<string, unknown> {
  const raw = bodyObject(request);
  if (Object.keys(raw).some(key => ![...keys, 'contextGeneration', 'contextToken'].includes(key)))
    throw new ApiError(422, 'ASSESSMENT_INPUT_INVALID', 'Review the current assessment inputs.');
  const { contextGeneration: _generation, contextToken: _token, ...value } = raw;
  return value;
}
export function registerAssessmentRoutes(app: FastifyInstance, db: Database, clock: Clock, service: Service): void {
  const current = (request: FastifyRequest): Session => transaction(db, () => {
    const session = requireSession(db, request, clock); guardContext(session, request);
    if (session.audience === 'CUSTOMER' && session.organization_id) requireOrganization(db, session, session.organization_id);
    if (session.audience === 'STAFF') requireStaff(db, session);
    return session;
  });
  const stillCurrent = (request: FastifyRequest, initial: Session) => {
    const session = current(request);
    if (session.cookie_hash !== initial.cookie_hash || session.context_generation !== initial.context_generation)
      throw new ApiError(409, 'CONTEXT_CHANGED', 'Your context changed while the assessment was prepared.');
    return session;
  };
  app.post('/api/orbital-assessments', async request => {
    const raw = payload(request, ['generation', 'brief', 'request']) as unknown as AssessmentStartInput;
    const session = current(request);
    if (session.audience === 'STAFF') throw new ApiError(403, 'CUSTOMER_REQUIRED', 'Technical planning belongs to public discovery or a permitted customer request.');
    if (raw.request !== undefined && (!raw.request || typeof raw.request !== 'object' || Array.isArray(raw.request) ||
      typeof raw.request.requestId !== 'string' || raw.request.requestId.length > 100 ||
      !Number.isSafeInteger(raw.request.requestVersion) || !Number.isSafeInteger(raw.request.briefRevision)))
      throw new ApiError(422, 'ASSESSMENT_INPUT_INVALID', 'Use the actual current request and brief revision.');
    if (raw.request) transaction(db, () => {
      const row = requestRow(db, raw.request!.requestId); if (!row) unavailable();
      requireOrganization(db, session, row.organization_id, true);
      if (row.aggregate_version !== raw.request!.requestVersion || row.current_brief_revision !== raw.request!.briefRevision)
        throw new ApiError(409, 'STALE_RECORD', 'Review the current saved request before preparing a new plan.');
      if (row.accepted_quote_id) throw new ApiError(409, 'ACCEPTED_WORK', 'Accepted work is immutable. Use Clarifications for a proposed change.');
    }, false);
    const result = await service.start(assessmentOwner(session, raw.request?.requestId ?? null), raw);
    stillCurrent(request, session); return result;
  });
  app.post('/api/orbital-assessments/status', async request => {
    const input = payload(request, ['assessmentId', 'generation', 'readCapability', 'cursor', 'kind', 'optionId']) as unknown as AssessmentReadInput;
    const session = current(request), result = await service.status(assessmentOwner(session), input);
    stillCurrent(request, session); return result;
  });
  app.post('/api/orbital-assessments/recheck',async request=>{
    const input=payload(request,['assessmentId','generation','readCapability','optionId','proposedAtUtc']) as unknown as AssessmentRecheckInput;
    const session=current(request),result=await service.recheck(assessmentOwner(session),input);
    stillCurrent(request,session);return result;
  });
  app.post('/api/orbital-assessments/cancel', async request => {
    const handle = payload(request, ['assessmentId', 'generation', 'readCapability']) as unknown as AssessmentHandle;
    const session = current(request), result = await service.cancel(assessmentOwner(session), handle);
    stillCurrent(request, session); return result;
  });
  app.post('/api/orbital-assessments/handoff', async request => {
    const raw = payload(request, ['handle']), session = current(request);
    return transaction(db, () => service.beginHandoff(assessmentOwner(session), raw.handle as AssessmentHandle));
  });
  const readSaved = async (request: FastifyRequest, requestId: string, organizationId?: string) => {
    const raw = payload(request, ['planId', 'cursor', 'kind', 'optionId']);
    if (typeof raw.planId !== 'string' || raw.planId.length > 100 ||
      raw.cursor !== undefined && (typeof raw.cursor !== 'string' || raw.cursor.length > 200) ||
      raw.optionId !== undefined && (typeof raw.optionId !== 'string' || raw.optionId.length > 200) ||
      raw.kind !== undefined && !['OPTIONS', 'OUTCOMES'].includes(String(raw.kind)))
      throw new ApiError(422, 'ASSESSMENT_INPUT_INVALID', 'Choose a saved plan and its evidence page.');
    const initial = current(request);
    const authorize = () => transaction(db, () => {
      const session = requireSession(db, request, clock); guardContext(session, request);
      if (session.cookie_hash !== initial.cookie_hash || session.context_generation !== initial.context_generation) unavailable();
      if (organizationId) requireOrganization(db, session, organizationId); else requireStaff(db, session);
      const row = requestRow(db, requestId); if (!row || organizationId && row.organization_id !== organizationId) unavailable();
      authorizeRequest(db, session, row);
      const projected = projectRequest(db, row);
      const plan = [projected.currentProposedPlan, ...projected.earlierProposedPlans, projected.acceptedPlan?.plan].find(value => value?.id === raw.planId);
      if (!plan) unavailable();
      return plan.assessment;
    }, false);
    const ref = authorize();
    return service.readSavedManifest(ref, () => { authorize(); }, raw.cursor as string | undefined, raw.kind as AssessmentPageKind | undefined, raw.optionId as string | undefined);
  };
  app.post<{ Params: { org: string; id: string } }>('/api/customer/:org/requests/:id/plan-evidence', request => readSaved(request, request.params.id, request.params.org));
  app.post<{ Params: { id: string } }>('/api/staff/requests/:id/plan-evidence', request => readSaved(request, request.params.id));
}
