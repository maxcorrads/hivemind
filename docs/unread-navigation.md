# Jump to the latest unread message

The unread-count badge beside a channel or direct conversation is a separate
button. Click it (or focus it and press Enter/Space) to open the **newest** unread
message in that conversation. Replies open their thread, including old threads
and replies beyond the initial page. The destination is briefly highlighted and
receives keyboard focus. Clicking the conversation name keeps normal navigation.

The jump loads a bounded historical page ending at the destination; it does not
load the whole conversation. Use Jump to recent or Refresh thread to resume live
navigation. New messages cannot displace the destination while viewing history.
Repeat the badge action to reach remaining unread messages. If another window
already read them, the UI reports that none remain and refreshes the counts.

## Read state and compatibility

`GET /api/ui/channels/:id/last-unread` is Human-session protected and returns
`{ target: { channelId, threadId, seq } }`, or `{ target: null }`. It applies the
same visibility, author exclusion, legacy read-through and individual receipt
rules as the badge count. It returns ordinary unread messages, not only mentions.
The lookup creates no read receipts and does not move a channel's read cursor.

Existing receipt semantics remain: only pages actually committed to the current
conversation/thread are acknowledged. This is not Mark all read. Other pages,
unopened threads and later live arrivals remain unread. Requests are cancelled
or ignored after navigation, including a second badge action or a delayed page.

A pending jump belongs to the navigation intent, not to one HTTP request.
Reconnect and automatic room/task/decision refreshes inherit its destination;
only the committed target page triggers focus and highlighting. A second jump,
explicit paging, return-to-live, or a selection change supersedes that intent.
This also cancels the initial `last-unread` lookup, before a destination has
been found. Delayed targets, empty results and errors from that lookup cannot
override a newer navigation action. Automatic refreshes do not cancel it.
The short-lived scroll anchor releases on mouse, touch or keyboard interaction
anywhere in the conversation pane, including its refresh button and composer.
Automatic updates to the same historical page retain the committed target
identity without restarting the highlight timer or stealing focus again.
Cancelling a pending thread jump also clears its owned load/return-to-live
state, including after a failed request. Cleanup cannot clear a newer jump,
send confirmation or explicit live-navigation action.

No schema migration, agent restart, permission change or monitor change is
required by this feature. Deploy the UI and server endpoint together; a frontend
asset refresh alone cannot add the endpoint to an already-running server.

The split navigation/badge buttons retain the active page's accessibility marker
and work in both the project sidebar and the mobile DM list. The existing
"New messages" divider, message grouping, long-press toolbar, system rows and
archived-channel disclosure remain intact.
A jump also reveals Messages when Tasks, Contract or Decisions was selected,
without discarding the composer's draft. Those tabs remain selectable afterwards.

## Verification

Regression coverage includes ordinary roots, old-thread replies, sparse and
legacy receipts, self-message exclusion, visibility, read-only GETs, historical
pages, full live-arrival windows, repeated same-thread jumps, keyboard activation,
navigation races and empty/failed lookups. Follow-up regressions cover in-flight
jumps replaced by reconnect/room refresh, a second jump, explicit cancellation,
and immediate return-to-live in both panes via mouse and keyboard. Delayed
destination lookups (success, empty and failure) are tested against explicit
live navigation and a subsequent badge click. Further coverage checks completed
anchors through automatic refresh and late reflow, paging during lookup, and
empty/failed replacement lookups after pending/failed target loads. Tests use
isolated fixtures, not real Human receipts. Mobile DM tests cover roots, replies
and system messages; tab-switch tests cover repeated root and reply jumps from
Tasks, Contract and Decisions while preserving drafts.
