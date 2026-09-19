from pathlib import Path
import re,subprocess
rx=re.compile(r'^<<<<<<< CURRENT\n(.*?)^=======\n(.*?)^>>>>>>> COORDINATION\n',re.S|re.M)
# Preserve unrelated/gate files; compose runtime conflicts explicitly.
for name in ['package.json','package-lock.json','scripts/run-tests.mjs','src/mcp/cancellation-contracts.test.ts','src/mcp/wait-loop.ts','src/server/thread-contracts.test.ts']:
    Path(name).write_bytes(subprocess.check_output(['git','show',f'HEAD:{name}']))
for name in ['README.md','src/cli.ts','src/mcp/bots.test.ts','src/server/inbox-delivery.test.ts','src/server/plugins.test.ts','src/server/plugins.ts','web/plugins.test.tsx']:
    p=Path(name);p.write_text(rx.sub(lambda m:m[1],p.read_text()))
p=Path('src/server/hive.ts');s=p.read_text();count=0
def hive_resolve(m):
    global count
    i=count;count+=1;a,b=m[1],m[2]
    if i==0: return a+b
    if i==1: return a+b[:b.index('import { assertAllowedMime')]
    if i==2: return a+'  readonly tasks!: TaskStore;\n  readonly rooms!: RoomStore;\n  readonly notifications!: NotificationStore;\n'
    if i==3: return a.replace('      this.inbox = new InboxDeliveryStore(this.db);', '      this.tasks = new TaskStore(this);\n      this.rooms = new RoomStore(this);\n      this.notifications = new NotificationStore(this);\n      this.inbox = new InboxDeliveryStore(this.db);').replace('new InboxReader(this.db, this.inbox);','new InboxReader(this.db, this.inbox, this.notifications, options.routineBatchMs ?? ROUTINE_BATCH_MS);')
    if i==4: return a+"    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'recipients')) {\n      this.db.exec(\"ALTER TABLE messages ADD COLUMN recipients TEXT NOT NULL DEFAULT '[]'\");\n    }\n"
    if i==5: return a.replace('    return this.transaction(() => {','    const create = () => {').replace('      this.afterCommit(() => this.bus.emit("channel", ch));','      if (!silent) this.afterCommit(() => this.bus.emit("channel", ch));').replace('    });','    };\n    // TaskStore owns the surrounding transaction when silent is requested.\n    return silent ? create() : this.transaction(create);')
    if i in [6,7,8,10,16,19]: return b
    if i==9: return a.replace('    if (attachmentIds.length) this.validateAttachments(actor, attachmentIds);\n\n    return this.transaction(() => {','    return this.transaction(() => {\n      if (attachmentIds.length) this.validateAttachments(actor, attachmentIds);')
    if i==12:
        a=a.replace('    const botEvents = new Map<string, BotEvent>();','''    const botEvents = new Map<string, BotEvent>();
    const taskEvents = new Map<string, TaskEnvelope>();
    for (const ids of batches(rows.map(row => row.id))) {
      const found = this.db.prepare(`SELECT message_id, envelope FROM task_events WHERE message_id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as Array<{ message_id: string; envelope: string }>;
      for (const event of found) taskEvents.set(event.message_id, JSON.parse(event.envelope) as TaskEnvelope);
    }''')
        return a.replace('      mentions: JSON.parse(row.mentions) as string[], createdAt: row.created_at,','''      mentions: JSON.parse(row.mentions) as string[], createdAt: row.created_at,
      ...(row.recipients && row.recipients !== '[]' ? { recipientIds: JSON.parse(row.recipients) as string[] } : {}),
      ...(taskEvents.has(row.id) ? { taskEvent: taskEvents.get(row.id)! } : {}),''')
    if i==17: return ''
    if i==18: return a+'        if (routineTimer) clearTimeout(routineTimer);\n'
    return a
s=rx.sub(hive_resolve,s);assert count==20
p.write_text(s)
p=Path('src/server/serve.ts');s=p.read_text();i=0
def serve(m):
    global i
    i+=1
    return m[1]+m[2] if i==1 else m[2].split('    wss.close();')[0]+m[1]
p.write_text(rx.sub(serve,s))
p=Path('web/api.ts');p.write_text(rx.sub(lambda m:m[1]+m[2],p.read_text()))
p=Path('web/App.tsx');s=p.read_text();s=rx.sub(lambda m:m[1],s)
a=s.index('  const loadThread = useCallback(async (id: string, root: string) => {');b=s.index('  const resetReadConnection',a);s=s[:a]+s[b:]
s=s.replace('    const requestId = ++threadLoadIdRef.current;','    const requestId = ++threadLoadIdRef.current;\n    const load = threadLoad.current.begin();')
s=s.replace('const data = await api.messages(channelId, root);','const data = await api.messages(channelId, root, undefined, load.signal);')
s=s.replace('if (viewingThread(channelId, root)) setThreadView','if (load.valid() && viewingThread(channelId, root)) setThreadView')
s=s.replace('if (viewingThread(channelId, root) && requestId === threadLoadIdRef.current)', 'if (load.valid() && viewingThread(channelId, root) && requestId === threadLoadIdRef.current)')
anchor='  const [draft, setDraft] = useState("");'
adapter='''  const setThreadPane = useCallback((update: ChannelPayload | null | ((pane: ChannelPayload | null) => ChannelPayload | null)) => {
    setThreadView(view => {
      const next = typeof update === "function" ? update(view?.pane ?? null) : update;
      if (!next) return null;
      if (!view) return null;
      return { ...view, pane: next };
    });
  }, []);
'''
s=s.replace(anchor,adapter+anchor)
s=s.replace('        resetReadConnection();\n        return;\n      }\n      if (ev.type === "telegram-health")', '        resetReadConnection();\n        setRoomTick(t => t + 1);\n        return;\n      }\n      if (ev.type === "telegram-health")',1)
s=s.replace('        setThreadPane((p) => patchPane(p, msg, threadIdRef.current));','        onThreadMessage(msg);')
s=s.replace('}, [loadChannel, refreshSnap, resetReadConnection, changeSelection]);', '}, [loadChannel, refreshSnap, resetReadConnection, changeSelection, onThreadMessage, viewingThread, loadThread, setThreadPane]);')
p.write_text(s)
p=Path('src/server/read-state.ts');s=p.read_text()
s=s.replace('EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value = ?)', '(EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value = ?) OR EXISTS (SELECT 1 FROM json_each(m.recipients) WHERE value = ?))')
s=s.replace('q.params.push(actorId);','q.params.push(actorId, actorId);')
p.write_text(s)
