import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { BriefInput, Context, RequestProjection } from '../../shared/contracts.js';
import type { QuoteDraftInput, ScheduleInput, StaffRequestProjection, WorkflowCommandName, WorkflowOutcome, WorkflowReview } from '../../shared/workflow.js';
import { createEmptyQuoteDraft, revisionToInput } from '../../shared/workflow.js';
import { compareDecimals } from '../../shared/decimal.js';
import { createEmptyBrief, areaSignature } from '../../shared/validation.js';
import { createConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db/database.js';
import { migrate } from '../../server/db/migrate.js';
import { initialize } from '../../server/db/initialize.js';
import { buildApp } from '../../server/app.js';
import type { TestHooks } from '../../server/commands.js';

const port=3102;
function briefInput(resolved=true):BriefInput{
  const area={latitude:52.6,longitude:-9.7,radiusKm:25,method:'coordinates' as const,generation:1};
  return {...createEmptyBrief(),purpose:'Compare the river and estuary before and after heavy rainfall.',sensor:'SAR',latitude:'52.6',longitude:'-9.7',areaChoice:area,areaConfirmation:areaSignature(area),
    baselineDate:'2026-10-07',recentDate:'2026-10-14',timezone:'UTC',maxResolution:'10',timingToDiscuss:!resolved,
    windowStart:resolved?'2026-10-23T08:00':'',windowEnd:resolved?'2026-10-25T18:00':'',
    contact:{name:'Demonstration contact',email:'workflow@coruscant.example',organization:'Demonstration research'},
    selectedEvidence:[{itemId:'demo-sar-03',evidenceVersion:'demo-evidence-v1'}],acknowledged:true};
}
class Client{
  cookie='';context:Context|null=null;
  constructor(public app:FastifyInstance){}
  headers(){return {host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`,'content-type':'application/json',...(this.cookie?{cookie:this.cookie}:{}),...(this.context?.csrfToken?{'x-coruscant-csrf':this.context.csrfToken}:{})};}
  get(path:string){return this.app.inject({method:'GET',url:path,headers:this.headers()});}
  post(path:string,payload:Record<string,unknown>){return this.app.inject({method:'POST',url:path,headers:this.headers(),payload:{contextGeneration:this.context?.contextGeneration,contextToken:this.context?.contextToken,...payload}});}
  async enter(persona='a-owner',org='org-a'){
    if(!this.context){const response=await this.app.inject({method:'POST',url:'/api/demo/bootstrap',headers:this.headers(),payload:{}});this.saveContext(response);}
    if(persona==='staff-admin')this.saveContext(await this.post('/api/demo/staff/enter',{}));
    else{this.saveContext(await this.post('/api/demo/customer/enter',{personaId:persona}));if(org)this.saveContext(await this.post('/api/context/workspace',{organizationId:org}));}
  }
  saveContext(response:Awaited<ReturnType<Client['get']>>){assert.equal(response.statusCode,200,response.body);const cookie=response.headers['set-cookie'];if(cookie)this.cookie=(Array.isArray(cookie)?cookie[0]!:cookie).split(';')[0]!;this.context=response.json<Context>();}
  async detail(id:string):Promise<StaffRequestProjection>{const response=await this.get(this.context?.audience==='STAFF'?`/api/staff/requests/${id}`:`/api/customer/${this.context!.organization!.id}/requests/${id}`);assert.equal(response.statusCode,200,response.body);return response.json<StaffRequestProjection>();}
  envelope(row:RequestProjection,payload:Record<string,unknown>={},quote?:{id:string;contentVersion:number}){
    return {commandId:randomUUID(),contextGeneration:this.context!.contextGeneration,contextToken:this.context!.contextToken,
      target:{requestId:row.id,...(quote?{quoteId:quote.id}:{})},expected:{requestVersion:row.requestVersion,briefRevision:row.briefRevision,...(quote?{quoteContentVersion:quote.contentVersion}:{})},payload};
  }
  async review(name:WorkflowCommandName,input:Record<string,unknown>){const response=await this.post(`/api/command-reviews/${name}`,input);assert.equal(response.statusCode,200,response.body);return response.json<WorkflowReview>();}
  async command(name:WorkflowCommandName,input:Record<string,unknown>,review=true){if(review){const confirmation=await this.review(name,input);input={...input,reviewToken:confirmation.reviewToken};}const response=await this.post(`/api/commands/${name}`,input);assert.equal(response.statusCode,200,response.body);return response.json<WorkflowOutcome>();}
}
async function fixture(hooks?:TestHooks){
  const dataRoot=mkdtempSync(join(tmpdir(),'coruscant-workflow-'));const config=createConfig({dataRoot,port});let now=new Date('2026-10-21T12:00:00.000Z');const clock=()=>new Date(now);
  const db=openDatabase(config);migrate(db);initialize(db,config,clock);db.close();let app=await buildApp({dataRoot,port,clock,testHooks:hooks});
  const owner=new Client(app),staff=new Client(app);await owner.enter();await staff.enter('staff-admin');
  return {dataRoot,config,owner,staff,get app(){return app;},clock,advance(ms:number){now=new Date(now.getTime()+ms);},
    async restart(){await app.close();app=await buildApp({dataRoot,port,clock});owner.app=app;staff.app=app;},async close(){await app.close();rmSync(dataRoot,{recursive:true,force:true});}};
}
async function submit(client:Client,brief=briefInput()){
  const payload={target:{organizationId:client.context!.organization!.id},expected:{},payload:{brief}};const reviewed=await client.post('/api/command-reviews/submitRequest',payload);assert.equal(reviewed.statusCode,200,reviewed.body);
  const command={...payload,commandId:randomUUID(),reviewToken:reviewed.json().reviewToken};const response=await client.post('/api/commands/submitRequest',command);assert.equal(response.statusCode,201,response.body);return {id:response.json().requestId as string,commandId:command.commandId};
}
function quoteInput(expiry='2026-10-22T18:00'):QuoteDraftInput{return {...createEmptyQuoteDraft(),priceType:'FIXED',amount:'2400.00',scope:'Demonstration SAR/Imagery comparison for the saved area and requested Baseline/Recent dates and resolved window. No real collection.',licence:'Demonstration use only; no operator rights are represented.',validUntil:expiry,recommendation:'Review the saved SAR evidence; availability remains unconfirmed.',recommendedEvidence:[{itemId:'demo-sar-03',evidenceVersion:'demo-evidence-v1'}]};}
const scheduleInput=():ScheduleInput=>({provider:'Coruscant demonstration provider',start:'2026-10-24T10:00',end:'2026-10-24T12:00',timezone:'UTC',trackedItemIds:[],notes:'Recorded plan only; not an operator confirmation.'});
async function start(staff:Client,id:string){await staff.command('startReview',staff.envelope(await staff.detail(id)),false);}
async function draft(staff:Client,id:string,quote=quoteInput()){
  const outcome=await staff.command('saveQuoteDraft',staff.envelope(await staff.detail(id),{quote}),false);const current=await staff.detail(id);return current.quoteDrafts.find(item=>item.id===outcome.quoteId)!;
}
async function publish(staff:Client,id:string,terms=quoteInput()){
  const saved=await draft(staff,id,terms);const row=await staff.detail(id);await staff.command('publishQuote',staff.envelope(row,{replacesQuoteId:row.currentQuote?.id??null},saved));return (await staff.detail(id)).currentQuote!;
}
async function accept(owner:Client,id:string){const row=await owner.detail(id);await owner.command('acceptQuote',owner.envelope(row,{},row.currentQuote!));return owner.detail(id);}
function count(app:FastifyInstance,table:string,requestId?:string){return (app.coruscant.db.prepare(`SELECT count(*) AS n FROM ${table}${requestId?' WHERE request_id=?':''}`).get(...(requestId?[requestId]:[])) as {n:number}).n;}

test('real request→private draft→publication→authorized acceptance→initial schedule shares durable immutable records',async()=>{
  const f=await fixture();try{
    const {id}=await submit(f.owner);await start(f.staff,id);const reviewing=await f.staff.detail(id);assert.equal(reviewing.status,'In review');
    const incomplete=await draft(f.staff,id,{...createEmptyQuoteDraft(),scope:'Private incomplete phrase'});assert.equal(incomplete.terms.priceType,null);
    const customer=await f.owner.get(`/api/customer/org-a/requests/${id}`);assert.equal(customer.json().currentQuote,null);assert.equal(customer.json().quoteDrafts,undefined);assert.ok(!customer.body.includes('Private incomplete phrase'));
    assert.equal((await f.staff.detail(id)).requestVersion,reviewing.requestVersion,'draft does not advance workflow version');
    const offer=await publish(f.staff,id);const before=await f.owner.detail(id);assert.equal(before.status,'Quote ready');assert.equal(before.currentQuote!.id,offer.id);assert.equal(before.currentQuote!.pricedBrief.baselineDate,'2026-10-07');assert.ok(before.currentQuote!.pricedBrief.requestedWindow);
    const accepted=await accept(f.owner,id);assert.equal(accepted.status,'Accepted');assert.equal(accepted.acceptedQuote!.id,offer.id);assert.equal(accepted.currentQuote,null);assert.equal(accepted.decisions[0]!.actorId,'a-owner');
    const input=f.staff.envelope(await f.staff.detail(id),{schedule:scheduleInput(),acceptedQuoteId:offer.id});const review=await f.staff.review('recordInitialSchedule',input);assert.equal(review.confirmation.schedule!.startUtc,'2026-10-24T10:00:00.000Z');assert.equal(review.confirmation.acceptedQuote!.id,offer.id);
    await f.staff.command('recordInitialSchedule',{...input,reviewToken:review.reviewToken},false);const plan=await f.owner.detail(id);assert.equal(plan.status,'Scheduled');assert.deepEqual(plan.schedule!.trackedItemIds,[]);assert.equal(plan.schedule!.acceptedQuoteId,offer.id);assert.equal(plan.schedule!.provider,scheduleInput().provider);
    const lineage=JSON.stringify({reference:plan.reference,brief:plan.brief,accepted:plan.acceptedQuote,decisions:plan.decisions,schedule:plan.schedule,history:plan.history});await f.restart();const after=await f.owner.detail(id);
    assert.equal(JSON.stringify({reference:after.reference,brief:after.brief,accepted:after.acceptedQuote,decisions:after.decisions,schedule:after.schedule,history:after.history}),lineage);
    f.advance(7*24*60*60*1000);f.owner.context=null;await f.owner.enter();assert.equal((await f.owner.detail(id)).status,'Scheduled','elapsed plan cannot execute delivery');
    assert.equal(count(f.app,'quote_decisions',id),1);assert.equal(count(f.app,'schedules',id),1);
    assert.throws(()=>f.app.coruscant.db.prepare('UPDATE quotes SET terms_json=? WHERE id=?').run('{}',offer.id),/immutable/);
    assert.throws(()=>f.app.coruscant.db.prepare("UPDATE quotes SET state='DRAFT' WHERE id=?").run(offer.id),/immutable|cannot be reopened/);
    assert.throws(()=>f.app.coruscant.db.prepare('UPDATE schedules SET plan_json=? WHERE request_id=?').run('{}',id),/immutable/);
    assert.deepEqual(after.history.map(item=>item.type),['Submitted','startReview','publishQuote','acceptQuote','recordInitialSchedule'],'equal-clock history follows actual insertion order');
  }finally{await f.close();}
});

test('questions and previewed replies follow real state transitions and retain exact authored text',async()=>{
  const f=await fixture();try{
    const {id}=await submit(f.owner);const early=f.owner.envelope(await f.owner.detail(id),{message:'Early reply'});assert.equal((await f.owner.post('/api/command-reviews/replyToTeam',early)).statusCode,409);
    await start(f.staff,id);const question='Please confirm the requested observation window.';await f.staff.command('askCustomer',f.staff.envelope(await f.staff.detail(id),{message:question}));
    assert.equal((await f.owner.detail(id)).status,'Needs information');await f.staff.command('askCustomer',f.staff.envelope(await f.staff.detail(id),{message:'Which comparison dates should the team price?'}));assert.equal((await f.owner.detail(id)).status,'Needs information');
    const raw=f.owner.envelope(await f.owner.detail(id),{message:'  These are requested dates, not acquisitions.\nPlease retain uncertainty.  '});const preview=await f.owner.review('replyToTeam',raw);
    const changed=await f.owner.post('/api/commands/replyToTeam',{...raw,payload:{message:'Edited after preview'},reviewToken:preview.reviewToken});assert.equal(changed.statusCode,409);assert.equal((await f.owner.detail(id)).messages.length,2);
    await f.owner.command('replyToTeam',{...raw,reviewToken:preview.reviewToken},false);const replied=await f.owner.detail(id);assert.equal(replied.status,'In review');assert.equal(replied.messages[0]!.message,question);assert.equal(replied.messages[2]!.message,(raw.payload as {message:string}).message);
    await publish(f.staff,id);const ready=await f.owner.detail(id);await f.owner.command('replyToTeam',f.owner.envelope(ready,{message:'A clarification must not change this quote.'}));assert.equal((await f.owner.detail(id)).status,'Quote ready');assert.equal((await f.owner.detail(id)).currentQuote!.id,ready.currentQuote!.id);
    await accept(f.owner,id);const before=await f.owner.detail(id);await f.staff.command('staffReply',f.staff.envelope(await f.staff.detail(id),{message:'Proposed changes require discussion; accepted terms stay fixed.'}));await f.owner.command('replyToTeam',f.owner.envelope(await f.owner.detail(id),{message:'Please discuss the proposed change without revising the agreement.'}));
    const after=await f.owner.detail(id);assert.equal(after.status,'Accepted');assert.deepEqual(after.acceptedQuote,before.acceptedQuote);assert.equal(after.briefRevision,before.briefRevision);
    for(const invalid of ['', ' '.repeat(3),'x'.repeat(4001)])assert.equal((await f.owner.post('/api/command-reviews/replyToTeam',f.owner.envelope(after,{message:invalid}))).statusCode,422);
  }finally{await f.close();}
});

test('revisions keep immutable contact and exact old evidence, invalidate a live offer and refuse after acceptance',async()=>{
  const f=await fixture();try{
    const {id}=await submit(f.owner);await start(f.staff,id);await publish(f.staff,id);
    const old=await f.owner.detail(id);const staleDraft=await draft(f.staff,id);const revised=revisionToInput(old.brief);
    revised.purpose='A revised river comparison, with its original submitted contact.';revised.baselineDate='2026-10-06';
    const forbidden=f.owner.envelope(old,{brief:{...revised,contact:{name:'Replacement',email:'different@coruscant.example',organization:'Changed'}}});
    const contact=await f.owner.post('/api/command-reviews/reviseBrief',forbidden);assert.equal(contact.statusCode,422);assert.ok(contact.json().fieldErrors.contact);
    // The current public source can disappear; an unchanged historical selection retains its saved facts.
    f.app.coruscant.db.prepare('DELETE FROM evidence_versions WHERE item_id=? AND evidence_version=?').run('demo-sar-03','demo-evidence-v1');
    revised.selectedEvidence.push({itemId:'missing-added-intention',evidenceVersion:'not-available'});
    await f.owner.command('reviseBrief',f.owner.envelope(old,{brief:revised}));const next=await f.owner.detail(id);
    assert.equal(next.status,'In review');assert.equal(next.briefRevision,2);assert.equal(next.currentQuote,null);assert.equal(next.earlierQuotes[0]!.state,'SUPERSEDED');assert.equal(next.title,revised.purpose);
    assert.deepEqual(next.brief.contact,old.brief.contact);assert.deepEqual(next.revisions[0]!.brief,old.brief);assert.deepEqual(next.evidence[0],old.evidence[0]);assert.equal(next.evidence[1]!.verified,false);assert.equal(next.revisions[0]!.evidence.length,1);
    const stalePublish=f.staff.envelope(await f.staff.detail(id),{replacesQuoteId:null},staleDraft);assert.equal((await f.staff.post('/api/command-reviews/publishQuote',stalePublish)).statusCode,409);
    await publish(f.staff,id,{...quoteInput(),recommendedEvidence:[]});await accept(f.owner,id);
    const locked=await f.owner.detail(id);assert.equal((await f.owner.post('/api/command-reviews/reviseBrief',f.owner.envelope(locked,{brief:revisionToInput(locked.brief)}))).statusCode,409);
    assert.throws(()=>f.app.coruscant.db.prepare('UPDATE brief_revisions SET brief_json=? WHERE request_id=? AND revision=1').run('{}',id),/immutable/);
    assert.throws(()=>f.app.coruscant.db.prepare('UPDATE service_requests SET current_brief_revision=1 WHERE id=?').run(id),/immutable/);
  }finally{await f.close();}
});

test('draft validation and publication blockers name the actual missing or invalid fact',async()=>{
  const f=await fixture();try{
    const {id}=await submit(f.owner,briefInput(false));await start(f.staff,id);
    for(const quote of [{...quoteInput(),amount:'-1'},{...quoteInput(),amount:'1e3'},{...quoteInput(),validUntil:'not a date'},{...quoteInput(),priceType:'RANGE',minimum:'2800',maximum:'2200'}]){
      const response=await f.staff.post('/api/commands/saveQuoteDraft',f.staff.envelope(await f.staff.detail(id),{quote}));assert.equal(response.statusCode,422,response.body);assert.ok(response.json().fieldErrors);
    }
    const saved=await draft(f.staff,id);const missingWindow=await f.staff.post('/api/command-reviews/publishQuote',f.staff.envelope(await f.staff.detail(id),{replacesQuoteId:null},saved));assert.equal(missingWindow.statusCode,422);assert.ok(missingWindow.json().fieldErrors.requestedWindow);
    const badRecommendation={...quoteInput(),recommendedEvidence:[{itemId:'demo-visible',evidenceVersion:'demo-evidence-v1'}]};
    assert.equal((await f.staff.post('/api/commands/saveQuoteDraft',f.staff.envelope(await f.staff.detail(id),{quote:badRecommendation}))).statusCode,422);
    const revision=revisionToInput((await f.owner.detail(id)).brief);revision.timingToDiscuss=false;revision.windowStart='2026-10-23T08:00';revision.windowEnd='2026-10-25T18:00';
    await f.owner.command('reviseBrief',f.owner.envelope(await f.owner.detail(id),{brief:revision}));
    const incomplete=await draft(f.staff,id,createEmptyQuoteDraft());const blank=await f.staff.post('/api/command-reviews/publishQuote',f.staff.envelope(await f.staff.detail(id),{replacesQuoteId:null},incomplete));assert.equal(blank.statusCode,422);assert.ok(blank.json().fieldErrors.scope);assert.ok(blank.json().fieldErrors.validUntil);
    const expired=await draft(f.staff,id,quoteInput('2026-10-20T12:00'));assert.equal((await f.staff.post('/api/command-reviews/publishQuote',f.staff.envelope(await f.staff.detail(id),{replacesQuoteId:null},expired))).statusCode,422);
    const equalRange=await publish(f.staff,id,{...quoteInput(),priceType:'RANGE',amount:'',minimum:'2200.00',maximum:'2200.000'});assert.equal(equalRange.terms.priceType,'RANGE');assert.equal(compareDecimals(equalRange.terms.minimum!,equalRange.terms.maximum!),0);assert.equal((await f.owner.detail(id)).status,'Quote ready');
  }finally{await f.close();}
});

test('a new private draft retains the live offer and explicit replacement invalidates stale decisions',async()=>{
  const f=await fixture();try{
    const {id}=await submit(f.owner);await start(f.staff,id);const first=await publish(f.staff,id);
    const decision=f.owner.envelope(await f.owner.detail(id),{},first);const oldReview=await f.owner.review('acceptQuote',decision);
    const second=await draft(f.staff,id,{...quoteInput(),scope:'Second private terms before explicit publication.',amount:'2600.0001'});
    const before=await f.owner.get(`/api/customer/org-a/requests/${id}`);assert.equal(before.json().currentQuote.id,first.id);assert.ok(!before.body.includes('Second private terms'));
    const publication=f.staff.envelope(await f.staff.detail(id),{replacesQuoteId:first.id},second);const preview=await f.staff.review('publishQuote',publication);assert.equal(preview.confirmation.replacesQuote!.id,first.id);assert.equal(preview.confirmation.quoteDraft!.terms.amount,'2600.0001');
    await f.staff.command('saveQuoteDraft',f.staff.envelope(await f.staff.detail(id),{quote:{...quoteInput(),amount:'2700.0001'}},second),false);
    assert.equal((await f.staff.post('/api/commands/publishQuote',{...publication,reviewToken:preview.reviewToken})).statusCode,409,'editing a saved draft invalidates its old publication review');
    const current=(await f.staff.detail(id)).quoteDrafts.find(item=>item.id===second.id)!;
    await f.staff.command('publishQuote',f.staff.envelope(await f.staff.detail(id),{replacesQuoteId:first.id},current));
    const after=await f.owner.detail(id);assert.equal(after.currentQuote!.id,second.id);assert.equal(after.earlierQuotes[0]!.state,'SUPERSEDED');assert.equal((await f.owner.post('/api/commands/acceptQuote',{...decision,reviewToken:oldReview.reviewToken})).statusCode,409);
    assert.equal((f.app.coruscant.db.prepare("SELECT count(*) AS n FROM quotes WHERE request_id=? AND state='PUBLISHED'").get(id) as {n:number}).n,1);
    assert.throws(()=>f.app.coruscant.db.prepare("UPDATE quotes SET state='DRAFT' WHERE id=?").run(first.id),/cannot be reopened/);
  }finally{await f.close();}
});

test('lost acceptance response recovers the committed decision after quote and confirmation expiry',async()=>{
  let lose=true;const f=await fixture({afterWorkflowCommit:(name)=>{if(name==='acceptQuote'&&lose){lose=false;throw new Error('Test-only lost response after committed acceptance');}}});try{
    const {id}=await submit(f.owner);await start(f.staff,id);const offer=await publish(f.staff,id,{...quoteInput('2026-10-21T13:00'),priceType:'RANGE',amount:'',minimum:'2200.1234567890123456789',maximum:'2800.1234567890123456790'});
    const input=f.owner.envelope(await f.owner.detail(id),{},offer);const review=await f.owner.review('acceptQuote',input);const attempt={...input,reviewToken:review.reviewToken};
    const lost=await f.owner.post('/api/commands/acceptQuote',attempt);assert.equal(lost.statusCode,503);assert.equal((await f.owner.detail(id)).status,'Accepted');
    f.advance(2*60*60*1000);await f.restart();const recovered=await f.owner.post('/api/commands/acceptQuote',attempt);assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().outcome,'replayed');
    const accepted=await f.owner.detail(id);assert.equal(accepted.acceptedQuote!.terms.minimum,'2200.1234567890123456789');assert.equal(accepted.acceptedQuote!.terms.priceType,'RANGE');assert.equal(count(f.app,'quote_decisions',id),1);assert.equal(accepted.history.filter(event=>event.type==='acceptQuote').length,1);
    const fresh=f.owner.envelope(accepted,{},accepted.acceptedQuote!);assert.equal((await f.owner.post('/api/command-reviews/acceptQuote',fresh)).statusCode,409);
    assert.equal((await f.owner.post('/api/commands/acceptQuote',{...attempt,payload:{meaningfulChange:true}})).statusCode,409);
  }finally{await f.close();}
});

test('new expired decisions fail without timer state changes and reasoned decline returns In review once',async()=>{
  const f=await fixture();try{
    const {id}=await submit(f.owner);await start(f.staff,id);const expired=await publish(f.staff,id,quoteInput('2026-10-21T13:00'));const initial=await f.owner.detail(id);const decision=f.owner.envelope(initial,{},expired);const review=await f.owner.review('acceptQuote',decision);
    f.advance(61*60*1000);const refusal=await f.owner.post('/api/commands/acceptQuote',{...decision,reviewToken:review.reviewToken});assert.equal(refusal.statusCode,409);assert.equal((await f.owner.detail(id)).status,'Quote ready');assert.equal(count(f.app,'quote_decisions',id),0);
    const replacement=await publish(f.staff,id,quoteInput('2026-10-22T18:00'));const ready=await f.owner.detail(id);
    for(const reason of ['', ' ', 'x'.repeat(2001)])assert.equal((await f.owner.post('/api/command-reviews/declineQuote',f.owner.envelope(ready,{reason},replacement))).statusCode,422);
    const raw=f.owner.envelope(ready,{reason:'The demonstration scope needs a revised quotation.'},replacement);const confirmation=await f.owner.review('declineQuote',raw);const attempt={...raw,reviewToken:confirmation.reviewToken};
    const saved=await f.owner.post('/api/commands/declineQuote',attempt);assert.equal(saved.statusCode,200,saved.body);assert.equal((await f.owner.post('/api/commands/declineQuote',attempt)).json().outcome,'replayed');
    const after=await f.owner.detail(id);assert.equal(after.status,'In review');assert.equal(after.currentQuote,null);assert.equal(after.acceptedQuote,null);assert.equal(after.schedule,null);assert.equal(after.decisions[0]!.reason,(raw.payload as {reason:string}).reason);assert.equal(after.earlierQuotes.find(item=>item.id===replacement.id)!.state,'DECLINED');assert.equal(count(f.app,'quote_decisions',id),1);
  }finally{await f.close();}
});

test('simultaneous decisions and same-key retries produce one immutable decision and receipt',async()=>{
  const f=await fixture();try{
    const {id}=await submit(f.owner);await start(f.staff,id);const quote=await publish(f.staff,id);const row=await f.owner.detail(id);
    const a=f.owner.envelope(row,{},quote),b=f.owner.envelope(row,{reason:'A different reviewed decision.'},quote);const ar=await f.owner.review('acceptQuote',a),br=await f.owner.review('declineQuote',b);
    const concurrent=await Promise.all([f.owner.post('/api/commands/acceptQuote',{...a,reviewToken:ar.reviewToken}),f.owner.post('/api/commands/declineQuote',{...b,reviewToken:br.reviewToken})]);assert.deepEqual(concurrent.map(item=>item.statusCode).sort(),[200,409]);assert.equal(count(f.app,'quote_decisions',id),1);
    const accepted=(await f.owner.detail(id)).acceptedQuote!;assert.ok(accepted);assert.equal((await f.owner.detail(id)).history.filter(item=>['acceptQuote','declineQuote'].includes(item.type)).length,1);
    const {id:second}=await submit(f.owner);await start(f.staff,second);const secondQuote=await publish(f.staff,second);const same=f.owner.envelope(await f.owner.detail(second),{},secondQuote);const sr=await f.owner.review('acceptQuote',same);const attempt={...same,reviewToken:sr.reviewToken};
    const retries=await Promise.all([f.owner.post('/api/commands/acceptQuote',attempt),f.owner.post('/api/commands/acceptQuote',attempt)]);assert.ok(retries.every(item=>item.statusCode===200));assert.deepEqual(retries.map(item=>item.json().outcome).sort(),['replayed','saved']);assert.equal(count(f.app,'quote_decisions',second),1);
  }finally{await f.close();}
});

test('current Owner grant, organization, audience and context gate both new decisions and receipt recovery',async()=>{
  const f=await fixture();try{
    const submitted=await submit(f.owner);const id=submitted.id;await start(f.staff,id);const quote=await publish(f.staff,id);const ownerRow=await f.owner.detail(id);
    for(const persona of ['a-requester','a-viewer']){const client=new Client(f.app);await client.enter(persona);assert.equal((await client.post('/api/command-reviews/acceptQuote',client.envelope(await client.detail(id),{},quote))).statusCode,403);}
    const b=new Client(f.app);await b.enter('b-owner','org-b');const cross=b.envelope(ownerRow,{},quote);const noLeak=await b.post('/api/command-reviews/acceptQuote',cross);assert.equal(noLeak.statusCode,404);assert.ok(!noLeak.body.includes(ownerRow.reference));
    assert.equal((await f.owner.post('/api/commands/startReview',f.owner.envelope(ownerRow))).statusCode,403);assert.equal((await f.staff.post('/api/command-reviews/acceptQuote',f.staff.envelope(ownerRow,{},quote))).statusCode,403);
    f.app.coruscant.db.prepare("UPDATE memberships SET can_select_offers=0 WHERE actor_id='a-owner' AND organization_id='org-a'").run();
    assert.equal((await f.owner.post('/api/command-reviews/acceptQuote',f.owner.envelope(ownerRow,{},quote))).statusCode,403);
    f.app.coruscant.db.prepare("UPDATE memberships SET can_select_offers=1 WHERE actor_id='a-owner' AND organization_id='org-a'").run();
    const input=f.owner.envelope(ownerRow,{},quote);const review=await f.owner.review('acceptQuote',input);const attempt={...input,reviewToken:review.reviewToken};await f.owner.post('/api/commands/acceptQuote',attempt);
    f.app.coruscant.db.prepare("UPDATE memberships SET can_select_offers=0 WHERE actor_id='a-owner' AND organization_id='org-a'").run();assert.equal((await f.owner.post('/api/commands/acceptQuote',attempt)).statusCode,403);
    f.app.coruscant.db.prepare("UPDATE memberships SET can_select_offers=1 WHERE actor_id='a-owner' AND organization_id='org-a'").run();
    f.owner.saveContext(await f.owner.post('/api/context/workspace',{organizationId:'org-a'}));assert.equal((await f.owner.post('/api/commands/acceptQuote',attempt)).statusCode,409);
    const collision=f.staff.envelope(await f.staff.detail(id));collision.commandId=submitted.commandId;const conflict=await f.staff.post('/api/commands/startReview',collision);assert.equal(conflict.statusCode,409);assert.equal(conflict.json().code,'ACTION_CONFLICT');assert.ok(!conflict.body.includes(ownerRow.reference));
  }finally{await f.close();}
});

test('initial scheduling validates accepted window, explicit times and identities, while retries cannot reschedule',async()=>{
  const f=await fixture();try{
    const {id}=await submit(f.owner);await start(f.staff,id);const quote=await publish(f.staff,id);
    const unaccepted=f.staff.envelope(await f.staff.detail(id),{schedule:scheduleInput(),acceptedQuoteId:quote.id});assert.equal((await f.staff.post('/api/command-reviews/recordInitialSchedule',unaccepted)).statusCode,409);
    await accept(f.owner,id);
    for(const schedule of [{...scheduleInput(),provider:''},{...scheduleInput(),timezone:''},{...scheduleInput(),end:'2026-10-24T09:00'},{...scheduleInput(),start:'2026-10-22T10:00'},{...scheduleInput(),trackedItemIds:['not-a-known-object']}]){
      const response=await f.staff.post('/api/command-reviews/recordInitialSchedule',f.staff.envelope(await f.staff.detail(id),{schedule,acceptedQuoteId:quote.id}));assert.equal(response.statusCode,422,response.body);assert.ok(response.json().fieldErrors);
    }
    const input=f.staff.envelope(await f.staff.detail(id),{schedule:{...scheduleInput(),trackedItemIds:['demo-sar-03']},acceptedQuoteId:quote.id});const review=await f.staff.review('recordInitialSchedule',input);const attempt={...input,reviewToken:review.reviewToken};
    const replies=await Promise.all([f.staff.post('/api/commands/recordInitialSchedule',attempt),f.staff.post('/api/commands/recordInitialSchedule',attempt)]);assert.ok(replies.every(item=>item.statusCode===200));assert.equal(count(f.app,'schedules',id),1);
    assert.equal((await f.staff.post('/api/command-reviews/recordInitialSchedule',f.staff.envelope(await f.staff.detail(id),{schedule:scheduleInput(),acceptedQuoteId:quote.id}))).statusCode,409);
    const plan=await f.owner.detail(id);assert.deepEqual(plan.schedule!.trackedItemIds,['demo-sar-03']);assert.equal(plan.schedule!.startUtc,'2026-10-24T10:00:00.000Z');
    await f.owner.command('replyToTeam',f.owner.envelope(plan,{message:'A proposed schedule change is only a clarification.'}));await f.staff.command('staffReply',f.staff.envelope(await f.staff.detail(id),{message:'The existing initial plan remains unchanged.'}));assert.deepEqual((await f.owner.detail(id)).schedule,plan.schedule);
  }finally{await f.close();}
});

test('a failed commercial transaction leaves no decision or state change, and unchanged retry succeeds',async()=>{
  const f=await fixture();let blocker:ReturnType<typeof openDatabase>|undefined;try{
    const {id}=await submit(f.owner);await start(f.staff,id);const quote=await publish(f.staff,id);const before=await f.owner.detail(id);const raw=f.owner.envelope(before,{},quote);const preview=await f.owner.review('acceptQuote',raw);const input={...raw,reviewToken:preview.reviewToken};
    f.app.coruscant.db.exec("CREATE TRIGGER test_workflow_failure BEFORE INSERT ON request_events WHEN NEW.type='acceptQuote' BEGIN SELECT RAISE(ABORT,'test-only history failure'); END");
    const failed=await f.owner.post('/api/commands/acceptQuote',input);assert.equal(failed.statusCode,503);assert.equal(count(f.app,'quote_decisions',id),0);assert.equal((await f.owner.detail(id)).status,'Quote ready');assert.deepEqual((await f.owner.detail(id)).history,before.history);
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM action_receipts WHERE command_id=?').get(input.commandId) as {n:number}).n,0);f.app.coruscant.db.exec('DROP TRIGGER test_workflow_failure');
    blocker=openDatabase(f.config);blocker.exec('BEGIN IMMEDIATE');const busy=await f.owner.post('/api/commands/acceptQuote',input);assert.equal(busy.statusCode,503);assert.equal(busy.json().code,'RETRY_LATER');blocker.exec('ROLLBACK');blocker.close();blocker=undefined;
    assert.equal((await f.owner.post('/api/commands/acceptQuote',input)).statusCode,200);assert.equal(count(f.app,'quote_decisions',id),1);assert.equal((await f.owner.detail(id)).status,'Accepted');
  }finally{if(blocker){blocker.exec('ROLLBACK');blocker.close();}await f.close();}
});
