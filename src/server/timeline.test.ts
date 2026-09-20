import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { HiveError } from '../shared/types.ts';
import { replayTimeline, TIMELINE_RETENTION_MS } from '../shared/timeline.ts';

function fixture(t: TestContext) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'hive-timeline-')), file=path.join(dir,'hive.db');
  let hive=new Hive(file);
  t.after(()=>{ try { hive.db.close(); } catch {} rmSync(dir,{recursive:true,force:true}); });
  const human=hive.getAgent('human'), brain=hive.join({role:'brain'}), worker=hive.join({role:'worker',seniority:'mid'});
  const channel=hive.createChannel(brain.agent,{name:'trace-room',type:'private',memberNames:[worker.agent.name]});
  const task=hive.tasks.assign(brain.agent,{requestId:'trace-task',worker:worker.agent.name,channel:channel.id,
    contract:{objective:'Trace a parser change',scope:['src/parser'],nonGoals:[],acceptanceCriteria:['Result reviewed'],dependencies:[],evidenceSeqs:[]}}).task;
  return { get hive(){return hive;}, file, human, brain, worker, channel, task,
    reopen(){hive.db.close(); hive=new Hive(file);} };
}
const status=(code:number)=>(error:unknown)=>error instanceof HiveError&&error.status===code;

test('task timeline traces assignment through delivery acknowledgement result and review, then replays fake-only', async t => {
  const f=fixture(t);
  const session=f.hive.openInboxSession(f.worker.agent,randomUUID());
  const mail=await f.hive.wait(f.worker.agent,5,undefined,{sessionId:session,compact:true});
  assert.ok(mail.delivery); assert.ok(mail.delivery.messageSeqs.includes(f.task.dispatchSeq));
  let timeline=f.hive.timeline.traceForTask(f.brain.agent,f.task.id);
  assert.ok(timeline.events.some(event=>event.kind==='delivery'&&event.stage==='offered'&&event.wakeReason==='targeted'));
  f.hive.acknowledgeInbox(f.worker.agent,session,mail.delivery.id);
  f.hive.tasks.event(f.worker.agent,f.task.id,{requestId:'accept',expectedRevision:1,action:{type:'accept'}});
  f.hive.tasks.event(f.worker.agent,f.task.id,{requestId:'result',expectedRevision:2,action:{type:'result',result:{
    summary:'Parser checked',artifacts:['dist/report.txt'],checks:[{name:'unit',outcome:'passed',evidenceSeqs:[]}],gaps:[],evidenceSeqs:[]}}});
  f.hive.tasks.event(f.brain.agent,f.task.id,{requestId:'review',expectedRevision:3,action:{type:'review',decision:'accepted',summary:'Reviewed',evidenceSeqs:[]}});
  timeline=f.hive.timeline.traceForTask(f.brain.agent,f.task.id);
  const actions=timeline.events.filter(event=>event.kind==='message').map(event=>event.taskAction).filter(Boolean);
  assert.deepEqual(actions,['assign','accept','result','review:accepted']);
  assert.ok(timeline.events.some(event=>event.kind==='delivery'&&event.stage==='acknowledged'));
  const exported=f.hive.timeline.exportTask(f.brain.agent,f.task.id);
  const serialized=JSON.stringify(exported);
  assert.doesNotMatch(serialized,/Parser checked|dist\/report\.txt|Reviewed|Brain|Worker/);
  assert.match(serialized,/"bodySha256"/); assert.match(serialized,/"actor":"brain-1"/);
  const replay=replayTimeline(exported);
  assert.equal(replay.finalTaskState,'accepted_complete');
  assert.equal(replay.orphanAcknowledgements.length,0);
  assert.deepEqual(replay.transitions,['assign','accept','result','review:accepted']);
});

test('Telegram source and explicit/inferred causality survive restart', t => {
  const f=fixture(t);
  const telegram=f.hive.postMessage(f.human,{channel:f.channel.id,threadId:f.task.id,body:'Telegram-origin answer',source:'telegram'});
  const inferred=f.hive.postMessage(f.brain.agent,{channel:f.channel.id,threadId:f.task.id,body:'Follow-up with thread causality'});
  const explicit=f.hive.postMessage(f.brain.agent,{channel:f.channel.id,threadId:f.task.id,body:'Follow-up with explicit cause',causeMessageId:telegram.id});
  let timeline=f.hive.timeline.traceForTask(f.brain.agent,f.task.id);
  const byId=(id:string)=>timeline.events.find(event=>event.kind==='message'&&event.messageId===id);
  assert.equal(byId(telegram.id)?.kind,'message');
  assert.equal((byId(telegram.id) as any).source,'telegram');
  assert.deepEqual((byId(inferred.id) as any).relation,{kind:'inferred',messageId:f.task.id});
  assert.deepEqual((byId(explicit.id) as any).relation,{kind:'explicit',messageId:telegram.id});
  f.reopen();
  assert.equal(f.hive.fromTelegram(telegram.id),true);
  timeline=f.hive.timeline.traceForTask(f.brain.agent,f.task.id);
  assert.equal((timeline.events.find(event=>event.kind==='message'&&event.messageId===telegram.id) as any).source,'telegram');
});

test('generic trace metadata is opt-in and rejects invisible cross-project causal references', t => {
  const f=fixture(t), traceId=randomUUID();
  const root=f.hive.postMessage(f.brain.agent,{channel:f.channel.id,body:'trace root',traceId});
  const child=f.hive.postMessage(f.brain.agent,{channel:f.channel.id,threadId:root.id,body:'explicit child',traceId,causeMessageId:root.id});
  const trace=f.hive.timeline.trace(f.brain.agent,traceId);
  assert.equal(trace.taskId,null);
  assert.deepEqual((trace.events.find(event=>event.kind==='message'&&event.messageId===child.id) as any).relation,{kind:'explicit',messageId:root.id});

  const other=f.hive.createProject(f.human,{name:'Other',slug:'other'});
  const otherBrain=f.hive.join({role:'brain',project:other.slug});
  const otherChannel=f.hive.createChannel(otherBrain.agent,{name:'other-room',type:'private'});
  const hidden=f.hive.postMessage(otherBrain.agent,{channel:otherChannel.id,body:'hidden cause'});
  assert.throws(()=>f.hive.postMessage(f.brain.agent,{channel:f.channel.id,body:'bad cause',causeMessageId:hidden.id}),status(403));
});

test('retention pruning never deletes active-task provenance or changes live task state', t => {
  const f=fixture(t), old=Date.now()-TIMELINE_RETENTION_MS-1000;
  f.hive.db.prepare('UPDATE message_provenance SET created_at=? WHERE trace_id=?').run(old,f.task.id);
  const before=f.hive.tasks.get(f.brain.agent,f.task.id);
  f.hive.timeline.prune(Date.now());
  assert.equal(f.hive.db.prepare('SELECT COUNT(*) AS n FROM message_provenance WHERE trace_id=?').get(f.task.id)!.n,1);
  assert.deepEqual(f.hive.tasks.get(f.brain.agent,f.task.id),before);

  f.hive.tasks.event(f.worker.agent,f.task.id,{requestId:'accept-prune',expectedRevision:1,action:{type:'accept'}});
  f.hive.tasks.event(f.worker.agent,f.task.id,{requestId:'result-prune',expectedRevision:2,action:{type:'result',result:{
    summary:'done',artifacts:[],checks:[],gaps:[],evidenceSeqs:[]}}});
  f.hive.tasks.event(f.brain.agent,f.task.id,{requestId:'review-prune',expectedRevision:3,action:{type:'review',decision:'accepted',summary:'ok',evidenceSeqs:[]}});
  f.hive.db.prepare('UPDATE message_provenance SET created_at=? WHERE trace_id=?').run(old,f.task.id);
  const removed=f.hive.timeline.prune(Date.now());
  assert.ok(removed.provenanceDeleted>=1);
  assert.equal(f.hive.tasks.get(f.brain.agent,f.task.id).state,'accepted_complete');
  assert.ok(f.hive.timeline.traceForTask(f.brain.agent,f.task.id).events.some(event=>event.kind==='message'&&event.taskAction==='review:accepted'));
});

test('timeline stats publish hard row/event caps and logical storage overhead', t => {
  const f=fixture(t);
  for(let i=0;i<50;i++) f.hive.postMessage(f.brain.agent,{channel:f.channel.id,threadId:f.task.id,body:'progress '+i,eventType:'progress'});
  const stats=f.hive.timeline.stats();
  assert.equal(stats.caps.provenance,50_000); assert.equal(stats.caps.deliveries,100_000); assert.equal(stats.caps.eventsPerTrace,500);
  assert.ok(stats.provenance>=51); assert.ok(stats.logicalBytes>0);
  assert.ok(stats.logicalBytes/stats.provenance<512,'logical provenance metadata should stay compact per row');
});
