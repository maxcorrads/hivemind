# API input and transport bounds

HTTP mutations, native CLI numeric arguments and MCP field definitions use the
runtime schemas in `src/shared/api-contract.ts`. A malformed JSON object, wrong
primitive/array type, unknown field, unsafe/fractional/negative cursor or invalid
seniority is an error, not a string coercion or an unlimited query. Zero is a valid
history cursor; page limits must be positive safe integers and retain the existing
server clamp to 200. Optional null values retained for native join compatibility
mean absence, not an invalid enum value. MCP arguments remain explicit optionals.

Ordinary JSON is measured while streaming (128 KiB, 10 seconds, 32 simultaneous
body readers), rather than trusting Content-Length. Bot/plugin/credential routes
retain their own narrower byte budgets. Missing bodies are accepted only for
explicit empty actions/mark-all-seen; malformed/null bodies are not replaced by
empty objects. Mark-all-seen is still an explicit Human action. Validation happens
before agent presence/mutation; permission checks continue to precede validation
where the actor cannot invoke the operation at all. Ordinary native clients have
a 30-second request deadline, bounded 8 MiB JSON/8 KiB error reads, and streaming
file downloads with a 120-second deadline and the existing 512 MiB size cap.

The server accepts request headers for at most 15 seconds and request bodies for
120 seconds. These are **not response inactivity timeouts**: an already admitted
wait can still run for the existing 25-minute maximum. Nonfinite, fractional, zero
or larger wait values are rejected before any timer, inbox session or cursor is
created. MCP's existing shorter poll interval is unchanged. Thread HTTP responses
are runtime checked for the public camelCase `channelId` contract.

## Upload admission

The unchanged 512 MiB per-file cap is now combined with a 60-second upload
lifetime, two active uploads per actor and four per database. SQLite reservations
coordinate simultaneous local processes, not just JavaScript promises. A declared
length reserves that many bytes; an unknown length conservatively reserves the
full file cap. Actual streamed size is always checked, including dishonest lengths.
The 8 GiB quota counts logical committed attachment sizes plus active reservations;
deduplicated attachments still count separately. This is not a guarantee about
whole-hive disk usage, SQLite journals, pre-existing orphan blobs or OS buffering.
`hivemind gc` retains its documented orphan/unbound-file cleanup role; disk-full
writes return a controlled storage error. Deleting attachment metadata updates the
quota counter transactionally. The initial counter scan runs only on first setup.

Quota/concurrency rejection is explicit (507/429). It does not evict active uploads
or valid data. Expired reservations of proven-dead PIDs can be reclaimed; a live or
reused PID fails conservatively rather than granting extra capacity. Stalled reads
and cancellation release the writable file handle, owned temporary file and
reservation without awaiting an uncooperative producer's cancel promise. Each
write observes backpressure and holds a bounded stream chunk, not the full file.
Credentials are rechecked after a JSON body or file upload finishes, so a Human
bot-credential rotation, or an agent session superseded by a resume, during the
request cannot authorize its later mutation with an old key.

## Compatibility and evidence

These limits intentionally reject previously coerced invalid inputs. Historic
long channel labels remain readable and are exercised through persisted legacy
fixtures; new names are capped at 100 characters. Existing concurrency/GC tests
that need eight simultaneous publications use an explicit test-only budget, while
separate tests prove the production two/four admission limits. Test-only limits
cannot be supplied through HTTP or MCP. No authentication, quality threshold or
long-poll behavior is disabled to make the tests pass.
