import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Audience, Context, Membership } from '../shared/contracts.js';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import { ApiError, unavailable } from './errors.js';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export function constantEqual(left: unknown, right: string): boolean {
  if (typeof left !== 'string' || left.length > 200) return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export interface Session {
  cookie_hash: string; audience: Audience; actor_id: string | null; organization_id: string | null;
  context_generation: number; context_token: string; csrf_token: string; expires_at: string;
  actor_name: string | null;
}
export type Clock = () => Date;
export function nowIso(clock: Clock) { return clock().toISOString(); }
export function demoCookieName(config: Pick<AppConfig, 'mode' | 'port'>): string {
  // Cookies ignore ports. Test servers must never replace the recording browser's demo context.
  return config.mode === 'test' ? `coruscant_demo_test_${config.port}` : 'coruscant_demo';
}
export function cookieValue(request: FastifyRequest): string | null {
  const prefix = `${demoCookieName(request.server.coruscant.config)}=`;
  const cookies = request.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(prefix)) ?? [];
  if (cookies.length !== 1) return null;
  const value = cookies[0]!.slice(prefix.length);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function findSession(db: Database, request: FastifyRequest, clock: Clock): Session | null {
  const cookie = cookieValue(request);
  if (!cookie) return null;
  const row = db.prepare(`SELECT s.*,a.name AS actor_name,a.active AS actor_active FROM sessions s
    LEFT JOIN actors a ON a.id=s.actor_id WHERE cookie_hash=? AND s.active=1`).get(hash(cookie)) as (Session & {actor_active:number|null}) | undefined;
  if (!row || row.expires_at <= nowIso(clock) || (row.actor_id && row.actor_active !== 1)) return null;
  return row;
}
export function requireSession(db: Database, request: FastifyRequest, clock: Clock): Session {
  const session = findSession(db, request, clock);
  if (!session) throw new ApiError(401, 'ACCESS_REQUIRED', 'Return to Demonstration access to check your current context.');
  touchSession(db,session,clock);
  return session;
}
/** Access activity extends only the demo session; GET never mutates a request or submits work. */
export function touchSession(db:Database,session:Session,clock:Clock):void {
  const now=nowIso(clock);const expiry=new Date(clock().getTime()+24*60*60*1000).toISOString();
  db.prepare('UPDATE sessions SET last_seen_at=?,expires_at=? WHERE cookie_hash=? AND active=1').run(now,expiry,session.cookie_hash);
}
export function bodyObject(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new ApiError(400, 'MALFORMED', 'A JSON object is required.');
  }
  return request.body as Record<string, unknown>;
}
export function guardTransport(request: FastifyRequest, config: AppConfig): void {
  if (request.headers.host !== config.allowedHost) throw new ApiError(403, 'HOST_REFUSED', 'Use the configured local Coruscant address.');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    if (request.headers.origin !== config.origin) throw new ApiError(403, 'ORIGIN_REFUSED', 'This action must come from the local application.');
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) {
      throw new ApiError(415, 'JSON_REQUIRED', 'Send application/json for this action.');
    }
  }
}
export function guardContext(session: Session, request: FastifyRequest): void {
  const body = bodyObject(request);
  if (!constantEqual(request.headers['x-coruscant-csrf'], session.csrf_token)) {
    throw new ApiError(403, 'CSRF_REFUSED', 'Check your current access before trying again.');
  }
  if (body.contextGeneration !== session.context_generation || !constantEqual(body.contextToken, session.context_token)) {
    throw new ApiError(409, 'CONTEXT_CHANGED', 'Your access context changed. Review this work in its original context.');
  }
}
export function memberships(db: Database, actorId: string): Membership[] {
  const rows = db.prepare(`SELECT m.organization_id,o.name,m.role,m.can_select_offers FROM memberships m
    JOIN organizations o ON o.id=m.organization_id WHERE m.actor_id=? AND m.active=1 ORDER BY o.name,m.organization_id`).all(actorId) as { organization_id:string;name:string;role:Membership['role'];can_select_offers:number }[];
  return rows.map(row => ({ organizationId:row.organization_id,organizationName:row.name,role:row.role,canSelectOffers:row.can_select_offers===1 }));
}
export function publicContext(clock: Clock): Context {
  return { audience:'PUBLIC',actor:null,organization:null,role:null,canSelectOffers:false,memberships:[],contextGeneration:0,contextToken:null,csrfToken:null,serverNow:nowIso(clock) };
}
export function contextFor(db: Database, session: Session | null, clock: Clock): Context {
  if (!session) return publicContext(clock);
  const list = session.actor_id && session.audience==='CUSTOMER' ? memberships(db,session.actor_id) : [];
  const selected = list.find(member => member.organizationId===session.organization_id);
  return { audience:session.audience,actor:session.actor_id?{id:session.actor_id,name:session.actor_name!}:null,
    organization:selected?{id:selected.organizationId,name:selected.organizationName}:null,
    role:selected?.role??null,canSelectOffers:selected?.canSelectOffers??false,memberships:list,
    contextGeneration:session.context_generation,contextToken:session.context_token,csrfToken:session.csrf_token,serverNow:nowIso(clock) };
}
export function rotateSession(db: Database, previous: Session | null, reply: FastifyReply, clock: Clock,
  audience: Audience, actorId: string | null = null, organizationId: string | null = null): Session {
  if (previous) db.prepare('UPDATE sessions SET active=0 WHERE cookie_hash=?').run(previous.cookie_hash);
  const cookie = randomToken(); const token = randomToken(); const csrf = randomToken(); const now = nowIso(clock);
  const expiry = new Date(clock().getTime()+24*60*60*1000).toISOString();
  db.prepare(`INSERT INTO sessions(cookie_hash,audience,actor_id,organization_id,context_generation,context_token,csrf_token,active,created_at,last_seen_at,expires_at)
    VALUES(?,?,?,?,?,?,?,1,?,?,?)`).run(hash(cookie),audience,actorId,organizationId,(previous?.context_generation??0)+1,token,csrf,now,now,expiry);
  reply.header('Set-Cookie',`${demoCookieName(reply.server.coruscant.config)}=${cookie}; Path=/; HttpOnly; SameSite=Strict`);
  return db.prepare(`SELECT s.*,a.name AS actor_name FROM sessions s LEFT JOIN actors a ON a.id=s.actor_id WHERE cookie_hash=?`).get(hash(cookie)) as unknown as Session;
}
export function requireCustomer(db: Database, session: Session): void {
  if (session.audience!=='CUSTOMER'||!session.actor_id) throw new ApiError(403,'CUSTOMER_REQUIRED','Choose a permitted demonstration customer workspace.');
  const actor=db.prepare('SELECT active,audience FROM actors WHERE id=?').get(session.actor_id) as {active:number;audience:string}|undefined;
  if (!actor||actor.active!==1||actor.audience!=='CUSTOMER') throw new ApiError(401,'ACCESS_REQUIRED','Current customer access is unavailable.');
}
export function requireOrganization(db: Database, session: Session, organizationId: string, write=false): Membership {
  requireCustomer(db,session);
  if (session.organization_id!==organizationId) unavailable();
  const member=memberships(db,session.actor_id!).find(value=>value.organizationId===organizationId);
  if (!member) unavailable();
  if (write&&member.role==='VIEWER') throw new ApiError(403,'READ_ONLY','Viewer access is read-only. Ask an Owner or Requester to submit.');
  return member;
}
export function requireStaff(db: Database, session: Session): void {
  const actor = session.actor_id ? db.prepare('SELECT active,audience FROM actors WHERE id=?').get(session.actor_id) as {active:number;audience:string}|undefined : undefined;
  if (session.audience!=='STAFF'||session.actor_id!=='staff-admin'||actor?.active!==1||actor.audience!=='STAFF') {
    throw new ApiError(403,'STAFF_REQUIRED','Separate demonstration staff access is required.');
  }
}
