import { readFileSync } from 'node:fs';
import { replayTimeline } from '../src/shared/timeline.ts';

const file=process.argv[2];
if(!file){ console.error('usage: npm run replay:timeline -- <redacted-fixture.json>'); process.exit(2); }
const fixture=JSON.parse(readFileSync(file,'utf8'));
const result=replayTimeline(fixture);
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(result.orphanAcknowledgements.length||result.duplicateMessageIds.length) process.exitCode=1;
