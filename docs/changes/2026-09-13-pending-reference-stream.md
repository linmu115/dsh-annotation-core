# Pending reference updates over the RC2 shared stream

Obsidian's latest capture reached the copy's durable annotation set in 1,376 ms;
a later authenticated pending-state read completed in 15 ms. These observations
separate backend capture from a delayed bubble display. The old UI waited for
changes through an unbounded unary HTTP request per composer. Several open
composers can occupy the browser's HTTP connection pool and delay ordinary reads
and mutations. The capture poll interval itself is 750 ms while visible.

The new optional `watchPending` Remote method uses RC2's shared WebSocket mux.
It yields the current pending snapshot and subsequent revisions. The composer
uses the stream when available, reconnects after interruption, ignores snapshots
older than an explicit refresh, and cancels its subscription when disposed. The
old unary method remains available to older clients. No note or conversation
history is copied by this change.

Validation covers gateway identity and cancellation, eight simultaneous
composers without unary waits, reconnection, existing composer behavior,
type checking and package build. These checks do not claim that every reported
UI delay has been reproduced in the user's active browser.

Release: dsh-annotation-core 0.3.12-rc2.2, with explicit peer compatibility updates
for the installed Sidechat, Lifecycle, Reference Adapter, Sticker Board and Suite.
