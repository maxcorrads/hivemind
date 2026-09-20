import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { Hive } from '../src/server/hive.ts';
import { TIMELINE_RETENTION_MS } from '../src/shared/timeline.ts';

const dir=mkdtempSync(path.join(os.tmpdir(),'hive-timeline-bench-')), hive=new Hive(path.join(dir,'hive.db'));
try{
  const brain=hive.join({role:'brain'}), worker=hive.join({role:'worker',seniority:'mid'});
  const channel=hive.createChannel(brain.agent,{name:'timeline-bench',type:'private',memberNames:[worker.agent.name]});
  const traceId=randomUUID();
  const root=hive.postMessage(brain.agent,{channel:channel.id,body:'benchmark root',traceId});
  const rows=500;
  for(let i=1;i<rows;i++) hive.postMessage(brain.agent,{channel:channel.id,threadId:root.id,body:'progress '+i,eventType:'progress',traceId});
  for(let i=0;i<10;i++) hive.timeline.trace(brain.agent,traceId);
  const samples=[];
  for(let i=0;i<50;i++){const start=performance.now(); hive.timeline.trace(brain.agent,traceId); samples.push(performance.now()-start);}
  samples.sort((a,b)=>a-b);
  const stats=hive.timeline.stats(), p=(q)=>samples[Math.min(samples.length-1,Math.floor(samples.length*q))];
  process.stdout.write(JSON.stringify({
    schemaVersion:1,rows,eventsReturned:hive.timeline.trace(brain.agent,traceId).events.length,
    logicalTimelineBytes:stats.logicalBytes,
    logicalBytesPerProvenance:stats.logicalBytes/Math.max(1,stats.provenance),
    queryMs:{p50:p(.5),p95:p(.95),max:samples.at(-1)},
    caps:stats.caps,retentionMs:TIMELINE_RETENTION_MS,
    note:'Same-machine observational benchmark; timing is not a cross-runner CI SLA.'
  },null,2)+'\n');
} finally { hive.db.close(); rmSync(dir,{recursive:true,force:true}); }
