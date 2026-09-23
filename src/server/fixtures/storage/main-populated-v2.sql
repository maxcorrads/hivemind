-- generated at 1790165275764
CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        seniority TEXT,
        focus TEXT,
        token_hash TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        inbox_cursor INTEGER NOT NULL DEFAULT 0
      , project_id TEXT);
CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        topic TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      , project_id TEXT);
CREATE TABLE channel_members (
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        PRIMARY KEY (channel_id, agent_id)
      );
CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        control TEXT,
        mentions TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      , event_type TEXT, recipients TEXT NOT NULL DEFAULT '[]');
CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        status TEXT
      );
CREATE TABLE reads (
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL,
        PRIMARY KEY (agent_id, channel_id)
      );
CREATE TABLE bot_events (
        message_id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        event_id TEXT NOT NULL,
        metadata TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        UNIQUE (bot_id, channel_id, thread_id, event_id)
      );
CREATE TABLE telegram_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
CREATE TABLE reactions (
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, agent_id, emoji)
      );
CREATE TABLE telegram_pending (
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL, bot_key TEXT, telegram_chat_id INTEGER, attempts INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (seq, kind)
      );
CREATE TABLE telegram_failures (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        telegram_chat_id INTEGER,
        reason TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolution TEXT
      , bot_key TEXT, destination_invalidated INTEGER NOT NULL DEFAULT 0);
CREATE TABLE bot_credentials (
      bot_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, revoked INTEGER NOT NULL
    );
CREATE TABLE projects (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    worktree TEXT, created_at INTEGER NOT NULL
  );
CREATE TABLE telegram_delivery_parts (
          seq INTEGER NOT NULL, part_key TEXT NOT NULL, bot_key TEXT NOT NULL,
          telegram_chat_id INTEGER NOT NULL, telegram_message_id INTEGER NOT NULL,
          completed_at INTEGER NOT NULL,
          PRIMARY KEY (seq, part_key, bot_key, telegram_chat_id)
        );
CREATE TABLE telegram_update_failures (
      id TEXT PRIMARY KEY, bot_key TEXT NOT NULL, update_id INTEGER NOT NULL,
      telegram_chat_id INTEGER, project_id TEXT, payload TEXT,
      attempts INTEGER NOT NULL, last_error TEXT NOT NULL, state TEXT NOT NULL,
      retry_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      invalidated INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bot_key, update_id)
    );
CREATE TABLE message_reads (
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          PRIMARY KEY (agent_id, message_id)
        );
CREATE TABLE ui_read_revision (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          revision INTEGER NOT NULL DEFAULT 0
        );
CREATE TABLE send_requests (
      actor_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, PRIMARY KEY(actor_id, project_id, request_id));
CREATE TABLE upload_usage (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), bytes INTEGER NOT NULL);
CREATE TABLE upload_reservations (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        bytes INTEGER NOT NULL, owner_pid INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE task_records (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, worker_id TEXT NOT NULL,
      dispatch_seq INTEGER NOT NULL, received_at INTEGER, snapshot TEXT NOT NULL);
CREATE TABLE task_events (
        message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, envelope TEXT NOT NULL,
        UNIQUE(actor_id, request_id));
CREATE TABLE task_request_aliases (actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,
        PRIMARY KEY(actor_id, request_id));
CREATE TABLE rooms (channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, snapshot TEXT NOT NULL);
CREATE TABLE room_events (actor_id TEXT NOT NULL, request_id TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        hash TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(actor_id, request_id));
CREATE TABLE room_tasks (task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, version INTEGER NOT NULL, action_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
        status TEXT NOT NULL, UNIQUE(channel_id, action_key));
CREATE TABLE room_acks (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, version INTEGER NOT NULL, PRIMARY KEY(channel_id, actor_id));
CREATE TABLE source_links (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, id TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(channel_id, bot_id, id));
CREATE TABLE notification_subscriptions (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '', event_types TEXT NOT NULL,
      PRIMARY KEY(agent_id, channel_id, thread_id));
CREATE TABLE worker_capabilities (
      worker_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, configuration TEXT NOT NULL, card TEXT NOT NULL);
CREATE TABLE routing_outcomes (
        task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worker_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        review_revision INTEGER NOT NULL, category TEXT NOT NULL, configuration TEXT NOT NULL,
        accepted INTEGER NOT NULL, recorded_at INTEGER NOT NULL);
CREATE TABLE message_provenance (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        trace_id TEXT NOT NULL,
        parent_message_id TEXT,
        cause_message_id TEXT,
        source TEXT NOT NULL CHECK(source IN ('hive','telegram','bot')),
        created_at INTEGER NOT NULL
      );
CREATE TABLE timeline_deliveries (
        delivery_id TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        message_seq INTEGER NOT NULL,
        wake_reason TEXT NOT NULL,
        offered_at INTEGER NOT NULL,
        last_offered_at INTEGER NOT NULL,
        acknowledged_at INTEGER,
        attempt INTEGER NOT NULL,
        PRIMARY KEY(delivery_id, agent_id, message_seq)
      );
CREATE TABLE decision_requests (
      id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,
      requester_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      UNIQUE(requester_id, request_id)
    );
CREATE TABLE decision_mutations (
      actor_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      decision_id TEXT NOT NULL REFERENCES decision_requests(id) ON DELETE CASCADE,
      request_hash TEXT NOT NULL,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      PRIMARY KEY(actor_id, request_id)
    );
CREATE TABLE adaptive_topology_executions (
  execution_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, brain_id TEXT NOT NULL, project_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL, snapshot TEXT NOT NULL, current INTEGER NOT NULL DEFAULT 1);
CREATE TABLE adaptive_topology_events (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        project_id TEXT NOT NULL, created_at INTEGER NOT NULL, snapshot TEXT NOT NULL);
CREATE TABLE adaptive_topology_locks (channel_id TEXT NOT NULL, brain_id TEXT NOT NULL,
        topology TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(channel_id,brain_id));
CREATE TABLE adaptive_topology_tasks (
        task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE, execution_id TEXT NOT NULL);
CREATE TABLE adaptive_topology_evaluated (execution_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(execution_id,event_id));
CREATE TABLE adaptive_topology_messages (
    root_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL, project_id TEXT NOT NULL,
    PRIMARY KEY(root_id,worker_id));
CREATE TABLE inbox_sessions (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY(agent_id, session_id), UNIQUE(agent_id, generation)
      );
CREATE TABLE inbox_deliveries (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        through_seq INTEGER NOT NULL,
        seqs TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        offered_at INTEGER NOT NULL,
        lease_until INTEGER NOT NULL,
        acknowledged_at INTEGER
      , superseded_by TEXT);
CREATE TABLE inbox_early_receipts (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        PRIMARY KEY(agent_id, seq)
      );
CREATE TABLE inbox_receipt_totals (
          agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
          acknowledged_messages INTEGER NOT NULL,
          last_acknowledged_at INTEGER NOT NULL
        );
CREATE TABLE adaptive_evidence_runs (
      execution_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL, snapshot TEXT NOT NULL);
CREATE TABLE adaptive_evidence_attempts (
      id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES adaptive_evidence_runs(execution_id) ON DELETE CASCADE,
      snapshot TEXT NOT NULL);
CREATE TABLE jev_calls (
      id TEXT PRIMARY KEY, route_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      execution_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      summary TEXT NOT NULL, sent TEXT, received TEXT, outcome TEXT);
CREATE TABLE telegram_bot_state (
      bot_key TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bot_key, key)
    );
CREATE TABLE telegram_bot_identities (
      bot_id INTEGER PRIMARY KEY, namespace TEXT NOT NULL UNIQUE
    );
CREATE TABLE telegram_routing_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE telegram_in (bot_key TEXT NOT NULL, update_id INTEGER NOT NULL, PRIMARY KEY (bot_key, update_id));
CREATE TABLE telegram_topics (bot_key TEXT NOT NULL, channel_id TEXT NOT NULL, telegram_thread_id INTEGER NOT NULL, telegram_chat_id INTEGER, PRIMARY KEY(bot_key, channel_id));
CREATE TABLE telegram_out (bot_key TEXT NOT NULL, telegram_chat_id INTEGER NOT NULL, telegram_message_id INTEGER NOT NULL, seq INTEGER NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT, PRIMARY KEY(bot_key, telegram_chat_id, telegram_message_id));
CREATE TABLE telegram_hold (bot_key TEXT NOT NULL, telegram_chat_id INTEGER NOT NULL, telegram_message_id INTEGER NOT NULL, telegram_thread_id INTEGER NOT NULL, payload TEXT NOT NULL, project_id TEXT, update_id INTEGER, PRIMARY KEY(bot_key, telegram_chat_id, telegram_message_id));
INSERT INTO "agents" VALUES('human','Human','human',NULL,NULL,'4909710b5f01eccfc051b4fbf512b25cc303cd4db7c7e5290c61fc25cd7dc737',1,1790165275784,1790165275784,0,NULL);
INSERT INTO "agents" VALUES('24e0e763-966b-4951-80af-0cc8a1d7dbc6','Datum','brain',NULL,NULL,'5e1f1edf4ffbbc63a20fa5adfac748492096e97cef1564f4742137e82a754601',1,1790165275793,1790165275793,1,'617268de-a5ac-4714-9f9f-9b612cb3bc4b');
INSERT INTO "agents" VALUES('8925f2dd-2238-4c42-b9af-bfe8ec4afa62','Pawl','worker','mid',NULL,'fa46b1d99909c16897b5ccd2814b7e224455dafb4e999c06b7272d58c5c783d9',1,1790165275794,1790165275794,10,'617268de-a5ac-4714-9f9f-9b612cb3bc4b');
INSERT INTO "agents" VALUES('96eb426f-5a79-42cd-affc-271191545518','Reamer','worker','senior',NULL,'fb2c430863f64b0b30529d45f8c3112b1ce02521f1a9752ff9e1c3bead3fb818',1,1790165275795,1790165275795,3,'617268de-a5ac-4714-9f9f-9b612cb3bc4b');
INSERT INTO "channels" VALUES('general','general','public','Town square','human',1790165275784,'617268de-a5ac-4714-9f9f-9b612cb3bc4b');
INSERT INTO "channels" VALUES('brains','brains','brains','Human and brains only','human',1790165275784,'617268de-a5ac-4714-9f9f-9b612cb3bc4b');
INSERT INTO "channels" VALUES('149f1a26-aacf-496c-8e0e-1f4f9403727c','fixture-room','private',NULL,'24e0e763-966b-4951-80af-0cc8a1d7dbc6',1790165275796,'617268de-a5ac-4714-9f9f-9b612cb3bc4b');
INSERT INTO "channels" VALUES('dm:24e0e763-966b-4951-80af-0cc8a1d7dbc6:8925f2dd-2238-4c42-b9af-bfe8ec4afa62','Datum · Pawl','dm',NULL,'24e0e763-966b-4951-80af-0cc8a1d7dbc6',1790165275816,'617268de-a5ac-4714-9f9f-9b612cb3bc4b');
INSERT INTO "channel_members" VALUES('general','human');
INSERT INTO "channel_members" VALUES('brains','human');
INSERT INTO "channel_members" VALUES('brains','24e0e763-966b-4951-80af-0cc8a1d7dbc6');
INSERT INTO "channel_members" VALUES('general','24e0e763-966b-4951-80af-0cc8a1d7dbc6');
INSERT INTO "channel_members" VALUES('general','8925f2dd-2238-4c42-b9af-bfe8ec4afa62');
INSERT INTO "channel_members" VALUES('general','96eb426f-5a79-42cd-affc-271191545518');
INSERT INTO "channel_members" VALUES('149f1a26-aacf-496c-8e0e-1f4f9403727c','human');
INSERT INTO "channel_members" VALUES('149f1a26-aacf-496c-8e0e-1f4f9403727c','24e0e763-966b-4951-80af-0cc8a1d7dbc6');
INSERT INTO "channel_members" VALUES('149f1a26-aacf-496c-8e0e-1f4f9403727c','8925f2dd-2238-4c42-b9af-bfe8ec4afa62');
INSERT INTO "channel_members" VALUES('149f1a26-aacf-496c-8e0e-1f4f9403727c','96eb426f-5a79-42cd-affc-271191545518');
INSERT INTO "channel_members" VALUES('dm:24e0e763-966b-4951-80af-0cc8a1d7dbc6:8925f2dd-2238-4c42-b9af-bfe8ec4afa62','24e0e763-966b-4951-80af-0cc8a1d7dbc6');
INSERT INTO "channel_members" VALUES('dm:24e0e763-966b-4951-80af-0cc8a1d7dbc6:8925f2dd-2238-4c42-b9af-bfe8ec4afa62','8925f2dd-2238-4c42-b9af-bfe8ec4afa62');
INSERT INTO "messages" VALUES(1,'ff5983ac-e03f-4558-bf90-8e1e235c1fc0','general',NULL,'human','Datum has joined as brain.','system',NULL,'[]',1790165275793,NULL,'[]');
INSERT INTO "messages" VALUES(2,'3ba7c452-1e9b-4ad5-a722-a6bb3dd2ad2f','general',NULL,'human','Pawl has joined as mid worker.','system',NULL,'[]',1790165275794,NULL,'[]');
INSERT INTO "messages" VALUES(3,'1502709e-e37d-4f6a-9e4f-14a190e51546','general',NULL,'human','Reamer has joined as senior worker.','system',NULL,'[]',1790165275795,NULL,'[]');
INSERT INTO "messages" VALUES(4,'3f9ffad3-40fb-4c7f-be01-b103d42568b8','149f1a26-aacf-496c-8e0e-1f4f9403727c',NULL,'human','Datum created #fixture-room','system',NULL,'[]',1790165275796,NULL,'[]');
INSERT INTO "messages" VALUES(5,'856f78cf-2361-454f-a681-5ebb40d7bb1e','149f1a26-aacf-496c-8e0e-1f4f9403727c',NULL,'human','Datum invited Pawl, Reamer','system',NULL,'[]',1790165275797,NULL,'[]');
INSERT INTO "messages" VALUES(6,'d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb','general',NULL,'human','Hello @Datum','chat',NULL,'["24e0e763-966b-4951-80af-0cc8a1d7dbc6"]',1790165275798,NULL,'[]');
INSERT INTO "messages" VALUES(7,'46acec3a-fee1-4c17-8f26-b1bd429e85a7','general','d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb','24e0e763-966b-4951-80af-0cc8a1d7dbc6','Reply','chat',NULL,'[]',1790165275799,NULL,'[]');
INSERT INTO "messages" VALUES(8,'740a0927-d1ad-4e69-b2e9-91cd3f126946','149f1a26-aacf-496c-8e0e-1f4f9403727c',NULL,'8925f2dd-2238-4c42-b9af-bfe8ec4afa62','Worker note','chat',NULL,'[]',1790165275799,NULL,'[]');
INSERT INTO "messages" VALUES(9,'5ef86404-e85d-4c4f-885b-8be43bea484a','general',NULL,'human','file','chat',NULL,'[]',1790165275809,NULL,'[]');
INSERT INTO "messages" VALUES(10,'aedb368f-948a-4960-bab0-99ea8099e863','dm:24e0e763-966b-4951-80af-0cc8a1d7dbc6:8925f2dd-2238-4c42-b9af-bfe8ec4afa62',NULL,'24e0e763-966b-4951-80af-0cc8a1d7dbc6','Task assign · aedb368f-948a-4960-bab0-99ea8099e863 · revision 1 / contract 1
Objective: Fixture objective
Scope: s
Non-goals: n
Acceptance: a
Dependencies: none
Worktree: worktrees/x; branch: feature/x
Evidence seqs: none','chat',NULL,'["8925f2dd-2238-4c42-b9af-bfe8ec4afa62"]',1790165275816,'assignment','["8925f2dd-2238-4c42-b9af-bfe8ec4afa62"]');
INSERT INTO sqlite_sequence VALUES('messages',10);
INSERT INTO "threads" VALUES('d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb','general','done');
INSERT INTO "threads" VALUES('aedb368f-948a-4960-bab0-99ea8099e863','dm:24e0e763-966b-4951-80af-0cc8a1d7dbc6:8925f2dd-2238-4c42-b9af-bfe8ec4afa62',NULL);
INSERT INTO "reads" VALUES('human','general',6);
INSERT INTO "bot_events" VALUES('bm1','8925f2dd-2238-4c42-b9af-bfe8ec4afa62','general','','e1','{}','h');
INSERT INTO "telegram_state" VALUES('outbox:fixture','1');
INSERT INTO "attachments" VALUES('e214fad2-1496-472b-a81e-d35fa7d7819a','5ef86404-e85d-4c4f-885b-8be43bea484a','a.txt','text/plain',7,'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d','human',1790165275809);
INSERT INTO "reactions" VALUES('d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb','human','👍',1790165275800);
INSERT INTO "telegram_pending" VALUES(6,'message','bot:4242',-100,1,1790165275764,0);
INSERT INTO "telegram_failures" VALUES('tf1',6,'message',-100,'r',1,1790165275764,NULL,NULL,'bot:4242',0);
INSERT INTO "bot_credentials" VALUES('96eb426f-5a79-42cd-affc-271191545518',2,0);
INSERT INTO "projects" VALUES('617268de-a5ac-4714-9f9f-9b612cb3bc4b','chapter','Chapter',NULL,1790165275784);
INSERT INTO "telegram_delivery_parts" VALUES(6,'p0','bot:4242',-100,7,1790165275764);
INSERT INTO "telegram_update_failures" VALUES('uf1','bot:4242',502,-100,'617268de-a5ac-4714-9f9f-9b612cb3bc4b','{}',1,'e','retry',1790165275764,1790165275764,1790165275764,0);
INSERT INTO "message_reads" VALUES('human','d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb');
INSERT INTO "ui_read_revision" VALUES(1,2);
INSERT INTO "send_requests" VALUES('8925f2dd-2238-4c42-b9af-bfe8ec4afa62','617268de-a5ac-4714-9f9f-9b612cb3bc4b','send-1','a4b8431c1a9cfb63120747dbe00b792b79aa4d500136009f38a9f4c75dfc8d89','740a0927-d1ad-4e69-b2e9-91cd3f126946',1790251675799);
INSERT INTO "upload_usage" VALUES(1,7);
INSERT INTO "upload_reservations" VALUES('res1','human',10,1,1790168875764);
INSERT INTO "task_records" VALUES('aedb368f-948a-4960-bab0-99ea8099e863','dm:24e0e763-966b-4951-80af-0cc8a1d7dbc6:8925f2dd-2238-4c42-b9af-bfe8ec4afa62','8925f2dd-2238-4c42-b9af-bfe8ec4afa62',10,1790165275820,'{"id":"aedb368f-948a-4960-bab0-99ea8099e863","channelId":"dm:24e0e763-966b-4951-80af-0cc8a1d7dbc6:8925f2dd-2238-4c42-b9af-bfe8ec4afa62","assignerId":"24e0e763-966b-4951-80af-0cc8a1d7dbc6","assignerName":"Datum","workerId":"8925f2dd-2238-4c42-b9af-bfe8ec4afa62","workerName":"Pawl","revision":1,"contractVersion":1,"state":"sent","contract":{"objective":"Fixture objective","scope":["s"],"nonGoals":["n"],"acceptanceCriteria":["a"],"dependencies":[],"worktree":"worktrees/x","branch":"feature/x","evidenceSeqs":[]},"dispatchSeq":10,"receivedAt":null,"lastEventSeq":10,"updatedAt":1790165275816,"result":null,"review":null}');
INSERT INTO "task_events" VALUES('aedb368f-948a-4960-bab0-99ea8099e863','aedb368f-948a-4960-bab0-99ea8099e863','24e0e763-966b-4951-80af-0cc8a1d7dbc6','assign-1','acb73f1dede110ae3cad090276e62eaddaf408f39e6bc6428c56eb9c58610167','{"taskId":"aedb368f-948a-4960-bab0-99ea8099e863","channelId":"dm:24e0e763-966b-4951-80af-0cc8a1d7dbc6:8925f2dd-2238-4c42-b9af-bfe8ec4afa62","revision":1,"contractVersion":1,"actorId":"24e0e763-966b-4951-80af-0cc8a1d7dbc6","actorRole":"brain","assignerId":"24e0e763-966b-4951-80af-0cc8a1d7dbc6","workerId":"8925f2dd-2238-4c42-b9af-bfe8ec4afa62","action":{"type":"assign","contract":{"objective":"Fixture objective","scope":["s"],"nonGoals":["n"],"acceptanceCriteria":["a"],"dependencies":[],"worktree":"worktrees/x","branch":"feature/x","evidenceSeqs":[]}}}');
INSERT INTO "task_request_aliases" VALUES('24e0e763-966b-4951-80af-0cc8a1d7dbc6','alias-1','h','aedb368f-948a-4960-bab0-99ea8099e863');
INSERT INTO "rooms" VALUES('149f1a26-aacf-496c-8e0e-1f4f9403727c','{}');
INSERT INTO "room_events" VALUES('human','r1','149f1a26-aacf-496c-8e0e-1f4f9403727c','h','d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb',1,'{}');
INSERT INTO "room_tasks" VALUES('aedb368f-948a-4960-bab0-99ea8099e863','149f1a26-aacf-496c-8e0e-1f4f9403727c',1,'k','p','open');
INSERT INTO "room_acks" VALUES('149f1a26-aacf-496c-8e0e-1f4f9403727c','8925f2dd-2238-4c42-b9af-bfe8ec4afa62',1);
INSERT INTO "source_links" VALUES('149f1a26-aacf-496c-8e0e-1f4f9403727c','8925f2dd-2238-4c42-b9af-bfe8ec4afa62','sensor','{}');
INSERT INTO "notification_subscriptions" VALUES('24e0e763-966b-4951-80af-0cc8a1d7dbc6','general','','["decision"]');
INSERT INTO "worker_capabilities" VALUES('8925f2dd-2238-4c42-b9af-bfe8ec4afa62','617268de-a5ac-4714-9f9f-9b612cb3bc4b',1,1790165275764,'c','{}');
INSERT INTO "routing_outcomes" VALUES('aedb368f-948a-4960-bab0-99ea8099e863','617268de-a5ac-4714-9f9f-9b612cb3bc4b','8925f2dd-2238-4c42-b9af-bfe8ec4afa62',1,'c','x',1,1790165275764);
INSERT INTO "message_provenance" VALUES('ff5983ac-e03f-4558-bf90-8e1e235c1fc0','ff5983ac-e03f-4558-bf90-8e1e235c1fc0',NULL,NULL,'hive',1790165275793);
INSERT INTO "message_provenance" VALUES('3ba7c452-1e9b-4ad5-a722-a6bb3dd2ad2f','3ba7c452-1e9b-4ad5-a722-a6bb3dd2ad2f',NULL,NULL,'hive',1790165275794);
INSERT INTO "message_provenance" VALUES('1502709e-e37d-4f6a-9e4f-14a190e51546','1502709e-e37d-4f6a-9e4f-14a190e51546',NULL,NULL,'hive',1790165275795);
INSERT INTO "message_provenance" VALUES('3f9ffad3-40fb-4c7f-be01-b103d42568b8','3f9ffad3-40fb-4c7f-be01-b103d42568b8',NULL,NULL,'hive',1790165275796);
INSERT INTO "message_provenance" VALUES('856f78cf-2361-454f-a681-5ebb40d7bb1e','856f78cf-2361-454f-a681-5ebb40d7bb1e',NULL,NULL,'hive',1790165275797);
INSERT INTO "message_provenance" VALUES('d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb','d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb',NULL,NULL,'hive',1790165275798);
INSERT INTO "message_provenance" VALUES('46acec3a-fee1-4c17-8f26-b1bd429e85a7','d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb','d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb',NULL,'hive',1790165275799);
INSERT INTO "message_provenance" VALUES('740a0927-d1ad-4e69-b2e9-91cd3f126946','740a0927-d1ad-4e69-b2e9-91cd3f126946',NULL,NULL,'hive',1790165275799);
INSERT INTO "message_provenance" VALUES('5ef86404-e85d-4c4f-885b-8be43bea484a','5ef86404-e85d-4c4f-885b-8be43bea484a',NULL,NULL,'hive',1790165275809);
INSERT INTO "message_provenance" VALUES('aedb368f-948a-4960-bab0-99ea8099e863','aedb368f-948a-4960-bab0-99ea8099e863',NULL,NULL,'hive',1790165275816);
INSERT INTO "timeline_deliveries" VALUES('d18eb491-3446-4188-bb25-21d2c8c2913f','8925f2dd-2238-4c42-b9af-bfe8ec4afa62',4,'channel_default',1790165275819,1790165275819,1790165275820,1);
INSERT INTO "timeline_deliveries" VALUES('d18eb491-3446-4188-bb25-21d2c8c2913f','8925f2dd-2238-4c42-b9af-bfe8ec4afa62',5,'channel_default',1790165275819,1790165275819,1790165275820,1);
INSERT INTO "timeline_deliveries" VALUES('d18eb491-3446-4188-bb25-21d2c8c2913f','8925f2dd-2238-4c42-b9af-bfe8ec4afa62',10,'targeted',1790165275819,1790165275819,1790165275820,1);
INSERT INTO "timeline_deliveries" VALUES('tdx','8925f2dd-2238-4c42-b9af-bfe8ec4afa62',6,'mention',1790165275764,1790165275764,NULL,1);
INSERT INTO "decision_requests" VALUES('d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb','617268de-a5ac-4714-9f9f-9b612cb3bc4b','general','aedb368f-948a-4960-bab0-99ea8099e863','24e0e763-966b-4951-80af-0cc8a1d7dbc6','d1','h',1790165275764,'{}');
INSERT INTO "decision_mutations" VALUES('human','dm1','d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb','h',NULL);
INSERT INTO "adaptive_topology_executions" VALUES('ex1','general','24e0e763-966b-4951-80af-0cc8a1d7dbc6','617268de-a5ac-4714-9f9f-9b612cb3bc4b','d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb','{}',1);
INSERT INTO "adaptive_topology_executions" VALUES('ex0','general','24e0e763-966b-4951-80af-0cc8a1d7dbc6','617268de-a5ac-4714-9f9f-9b612cb3bc4b','d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb','{}',0);
INSERT INTO "adaptive_topology_events" VALUES('ev1','ex1','general','617268de-a5ac-4714-9f9f-9b612cb3bc4b',1790165275764,'{}');
INSERT INTO "adaptive_topology_locks" VALUES('general','24e0e763-966b-4951-80af-0cc8a1d7dbc6','single',1790165275764);
INSERT INTO "adaptive_topology_tasks" VALUES('aedb368f-948a-4960-bab0-99ea8099e863','ex1');
INSERT INTO "adaptive_topology_evaluated" VALUES('ex1','ev1');
INSERT INTO "adaptive_topology_messages" VALUES('d60b3265-eeac-4d87-9ec5-ddd1e1fe12cb','8925f2dd-2238-4c42-b9af-bfe8ec4afa62','ex1','617268de-a5ac-4714-9f9f-9b612cb3bc4b');
INSERT INTO "inbox_sessions" VALUES('8925f2dd-2238-4c42-b9af-bfe8ec4afa62','6d4c3c3e-d297-4ea0-afc8-4d5add486de2',1);
INSERT INTO "inbox_deliveries" VALUES('d18eb491-3446-4188-bb25-21d2c8c2913f','8925f2dd-2238-4c42-b9af-bfe8ec4afa62','6d4c3c3e-d297-4ea0-afc8-4d5add486de2',10,'[4,5,10]',1,1790165275819,1790165575819,1790165275820,NULL);
INSERT INTO "inbox_early_receipts" VALUES('8925f2dd-2238-4c42-b9af-bfe8ec4afa62',99999);
INSERT INTO "inbox_receipt_totals" VALUES('8925f2dd-2238-4c42-b9af-bfe8ec4afa62',3,1790165275820);
INSERT INTO "adaptive_evidence_runs" VALUES('ex1','general','617268de-a5ac-4714-9f9f-9b612cb3bc4b','{}');
INSERT INTO "adaptive_evidence_attempts" VALUES('at1','ex1','{}');
INSERT INTO "jev_calls" VALUES('jc1','route1','617268de-a5ac-4714-9f9f-9b612cb3bc4b','general','ex1',1790165275764,'{}','{}','{}','ok');
INSERT INTO "telegram_bot_state" VALUES('bot:4242','offset','501');
INSERT INTO "telegram_bot_identities" VALUES(4242,'bot:4242');
INSERT INTO "telegram_routing_migrations" VALUES(1);
INSERT INTO "telegram_in" VALUES('bot:4242',500);
INSERT INTO "telegram_topics" VALUES('bot:4242','general',11,-100);
INSERT INTO "telegram_out" VALUES('bot:4242',-100,7,6,'general',NULL);
INSERT INTO "telegram_hold" VALUES('bot:4242',-100,8,11,'{}','617268de-a5ac-4714-9f9f-9b612cb3bc4b',501);
CREATE INDEX idx_messages_channel_seq ON messages(channel_id, seq);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_channel_thread_seq ON messages(channel_id, thread_id, seq);
CREATE INDEX idx_attachments_message ON attachments(message_id);
CREATE INDEX idx_telegram_failures_open ON telegram_failures(resolved_at, created_at);
CREATE INDEX idx_agents_project_role ON agents(project_id, role);
CREATE INDEX idx_agents_role ON agents(role);
CREATE INDEX idx_channels_project_type_name ON channels(project_id, type, name);
CREATE INDEX idx_channel_members_agent_channel ON channel_members(agent_id, channel_id);
CREATE INDEX idx_telegram_parts_seq ON telegram_delivery_parts(seq);
CREATE INDEX idx_telegram_update_retry ON telegram_update_failures(bot_key, state, retry_at);
CREATE INDEX message_reads_message ON message_reads(message_id);
CREATE TRIGGER ui_read_message_reads_insert
            AFTER INSERT ON message_reads BEGIN
              UPDATE ui_read_revision SET revision = revision + 1 WHERE singleton = 1;
            END;
CREATE TRIGGER ui_read_message_reads_delete
            AFTER DELETE ON message_reads BEGIN
              UPDATE ui_read_revision SET revision = revision + 1 WHERE singleton = 1;
            END;
CREATE TRIGGER ui_read_reads_insert
            AFTER INSERT ON reads BEGIN
              UPDATE ui_read_revision SET revision = revision + 1 WHERE singleton = 1;
            END;
CREATE TRIGGER ui_read_reads_update
            AFTER UPDATE ON reads BEGIN
              UPDATE ui_read_revision SET revision = revision + 1 WHERE singleton = 1;
            END;
CREATE TRIGGER ui_read_reads_delete
            AFTER DELETE ON reads BEGIN
              UPDATE ui_read_revision SET revision = revision + 1 WHERE singleton = 1;
            END;
CREATE TRIGGER ui_read_messages_delete
            AFTER DELETE ON messages BEGIN
              UPDATE ui_read_revision SET revision = revision + 1 WHERE singleton = 1;
            END;
CREATE TRIGGER ui_read_channels_delete
            AFTER DELETE ON channels BEGIN
              UPDATE ui_read_revision SET revision = revision + 1 WHERE singleton = 1;
            END;
CREATE TRIGGER ui_read_projects_delete
            AFTER DELETE ON projects BEGIN
              UPDATE ui_read_revision SET revision = revision + 1 WHERE singleton = 1;
            END;
CREATE INDEX send_request_expiry ON send_requests(expires_at);
CREATE INDEX send_actor_expiry ON send_requests(actor_id,expires_at);
CREATE TRIGGER upload_usage_insert AFTER INSERT ON attachments BEGIN
        UPDATE upload_usage SET bytes = bytes + NEW.bytes WHERE singleton = 1; END;
CREATE TRIGGER upload_usage_delete AFTER DELETE ON attachments BEGIN
        UPDATE upload_usage SET bytes = bytes - OLD.bytes WHERE singleton = 1; END;
CREATE TRIGGER upload_usage_change AFTER UPDATE OF bytes ON attachments BEGIN
        UPDATE upload_usage SET bytes = bytes + NEW.bytes - OLD.bytes WHERE singleton = 1; END;
CREATE INDEX upload_reservations_expiry ON upload_reservations(expires_at);
CREATE INDEX upload_reservations_actor ON upload_reservations(actor_id);
CREATE INDEX task_dispatch ON task_records(worker_id, dispatch_seq);
CREATE INDEX task_channel ON task_records(channel_id);
CREATE INDEX task_worker_handoff ON task_records(worker_id, id) WHERE json_extract(snapshot, '$.state') != 'accepted_complete';
CREATE INDEX task_assigner_handoff ON task_records(json_extract(snapshot, '$.assignerId'), id) WHERE json_extract(snapshot, '$.state') != 'accepted_complete';
CREATE INDEX task_event_task ON task_events(task_id);
CREATE INDEX task_held_claims ON task_records(channel_id, id)
      WHERE json_extract(snapshot, '$.claim.state') = 'held';
CREATE INDEX capabilities_project ON worker_capabilities(project_id, worker_id);
CREATE INDEX routing_evidence ON routing_outcomes(worker_id, category, configuration, recorded_at DESC);
CREATE INDEX routing_project_retention ON routing_outcomes(project_id, recorded_at);
CREATE INDEX timeline_trace_created ON message_provenance(trace_id, created_at, message_id);
CREATE INDEX timeline_delivery_seq ON timeline_deliveries(message_seq, offered_at);
CREATE TRIGGER timeline_message_default AFTER INSERT ON messages
      BEGIN
        INSERT OR IGNORE INTO message_provenance(message_id, trace_id, parent_message_id, cause_message_id, source, created_at)
        VALUES (NEW.id, COALESCE(NEW.thread_id, NEW.id), NEW.thread_id, NULL, 'hive', NEW.created_at);
      END;
CREATE INDEX decision_project_created ON decision_requests(project_id, created_at DESC);
CREATE INDEX decision_task_created ON decision_requests(task_id, created_at DESC);
CREATE UNIQUE INDEX idx_adaptive_topology_current ON adaptive_topology_executions(channel_id,brain_id) WHERE current=1;
CREATE INDEX idx_adaptive_topology_brain ON adaptive_topology_executions(brain_id,project_id);
CREATE INDEX idx_adaptive_topology_root ON adaptive_topology_executions(root_message_id);
CREATE INDEX idx_adaptive_topology_events_channel ON adaptive_topology_events(channel_id,created_at DESC);
CREATE INDEX idx_adaptive_topology_tasks_execution ON adaptive_topology_tasks(execution_id);
CREATE INDEX idx_adaptive_message_execution ON adaptive_topology_messages(execution_id);
CREATE INDEX idx_adaptive_message_worker ON adaptive_topology_messages(worker_id);
CREATE TRIGGER adaptive_channel_deleted AFTER DELETE ON channels BEGIN
      DELETE FROM adaptive_topology_evaluated WHERE execution_id IN
        (SELECT execution_id FROM adaptive_topology_executions WHERE channel_id=OLD.id);
      DELETE FROM adaptive_topology_events WHERE channel_id=OLD.id;
      DELETE FROM adaptive_topology_locks WHERE channel_id=OLD.id;
      DELETE FROM adaptive_topology_executions WHERE channel_id=OLD.id;
    END;
CREATE INDEX inbox_agent_receipts ON inbox_deliveries(agent_id, acknowledged_at);
CREATE UNIQUE INDEX inbox_one_pending
        ON inbox_deliveries(agent_id) WHERE acknowledged_at IS NULL AND superseded_by IS NULL;
CREATE INDEX adaptive_evidence_channel ON adaptive_evidence_runs(channel_id);
CREATE INDEX adaptive_evidence_execution ON adaptive_evidence_attempts(execution_id);
CREATE INDEX idx_jev_calls_project ON jev_calls(project_id, created_at DESC);
CREATE INDEX idx_jev_calls_execution ON jev_calls(execution_id, created_at);
CREATE INDEX idx_telegram_out_seq ON telegram_out(seq);
CREATE INDEX idx_telegram_topics_namespace_topic ON telegram_topics(bot_key, telegram_chat_id, telegram_thread_id);
PRAGMA user_version = 2;
