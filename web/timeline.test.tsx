import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { TimelinePanel } from './TimelinePanel.tsx';
import { api } from './api.ts';
import type { TimelineView } from '../src/shared/timeline.ts';

const window=new Window({url:'http://localhost/'});
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Blob:window.Blob,URL:window.URL,IS_REACT_ACT_ENVIRONMENT:true});
const {createRoot}=await import('react-dom/client');
after(()=>window.happyDOM.close());

const timeline:TimelineView={traceId:'11111111-1111-4111-8111-111111111111',taskId:'11111111-1111-4111-8111-111111111111',truncated:false,
 warning:'Observability only',events:[
  {kind:'message',id:'m1',at:1,traceId:'11111111-1111-4111-8111-111111111111',messageId:'22222222-2222-4222-8222-222222222222',seq:1,
   authorId:'brain',authorName:'Brain',authorRole:'brain',source:'hive',eventType:'assignment',taskAction:'assign',relation:null,bodyBytes:20,bodySha256:'abc',
   references:{evidenceSeqs:[],artifactCount:0,checkCount:0}},
  {kind:'message',id:'m2',at:2,traceId:'11111111-1111-4111-8111-111111111111',messageId:'33333333-3333-4333-8333-333333333333',seq:2,
   authorId:'worker',authorName:'Worker',authorRole:'worker',source:'hive',eventType:'progress',taskAction:null,
   relation:{kind:'inferred',messageId:'22222222-2222-4222-8222-222222222222'},bodyBytes:10,bodySha256:'def',
   references:{evidenceSeqs:[],artifactCount:0,checkCount:0}},
  {kind:'delivery',id:'d1',at:3,traceId:'11111111-1111-4111-8111-111111111111',messageId:'22222222-2222-4222-8222-222222222222',seq:1,
   agentId:'worker',agentName:'Worker',agentRole:'worker',stage:'offered',deliveryId:'44444444-4444-4444-8444-444444444444',attempt:1,wakeReason:'task'},
 ]};

test('timeline UI distinguishes inferred causality and transport wake reason',async t=>{
 t.mock.method(api,'taskTimeline',async()=>({timeline}));
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(<TimelinePanel taskId={timeline.taskId!}/>));
  const summary=host.querySelector('summary') as HTMLElement; await act(async()=>summary.click());
  assert.match(host.textContent!,/inferred thread parent/);
  assert.match(host.textContent!,/offered → Worker · task/);
  assert.match(host.textContent!,/Observability only/);
 }finally{await act(async()=>root.unmount());host.remove();}
});
