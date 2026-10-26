import type { DeliveryProjection } from '../shared/delivery.js';
import type { Database } from './db/database.js';

/** Historical customer-safe workflow fact; this projection grants no current material access. */
export function deliveryForRequest(db:Database,requestId:string):DeliveryProjection|null {
  const row=db.prepare('SELECT d.*,a.name AS actor_name FROM deliveries d JOIN actors a ON a.id=d.actor_id WHERE d.request_id=?').get(requestId) as {id:string;request_id:string;organization_id:string;result_id:string;schedule_id:string;note:string;actor_id:string;actor_name:string;created_at:string;request_version:number}|undefined;
  return row?{id:row.id,requestId:row.request_id,organizationId:row.organization_id,resultId:row.result_id,scheduleId:row.schedule_id,note:row.note,actorId:row.actor_id,actorName:row.actor_name,occurredAt:row.created_at,requestVersion:row.request_version}:null;
}
