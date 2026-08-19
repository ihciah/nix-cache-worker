# RFC-0010: consistency and job-recovery hardening

- Status: Implemented
- Date: 2026-08-19

## Context

The initial implementation has safe behavior on the normal upload and deletion
paths, but several asynchronous and cross-store failure windows can race with
registration, reuse a key while it is being deleted, strand a running job, or
leave an R2 object without a repairable D1 index.

## Goals and non-goals

- Make version deletion and automatic GC mutually exclusive with registration,
  metadata updates, and pin changes.
- Make queued jobs recoverable after a Worker interruption and keep large job
  processing bounded.
- Preserve object immutability across concurrent normal and multipart uploads.
- Make R2-to-D1 indexing failures repairable by a later idempotent retry.
- Preserve direct Nix HTTP compatibility while tightening narinfo validation and
  conditional-request semantics.
- Improve cache invalidation, audit durability, and structured event fields.

This RFC does not add a custom client upload protocol or change the public
authentication roles.

## Design

Deletion job creation atomically transitions an active target version to
`deleting` and inserts the job. Registration first conditionally transitions a
version to `registering`; deletion does not claim that state, so multi-batch
registration is serialized against deletion. Registration only inserts members
whose narinfo and NAR are still ready, and deletion marks objects only while
their live-reference guard still holds. Version patching, pinning, and
duplicate deletion requests observe these states and cannot mutate the target.
Automatic GC jobs record their reason and re-check their target before
processing legacy or otherwise recoverable jobs.

All application uploads acquire the per-key D1 write claim before preflighting
R2 or D1, including idempotent retries for existing objects. Multipart claims
are renewed while parts are being consumed. A key with a `deleting` D1 object
row cannot be reused until deletion cleanup has completed.

Deletion retries treat an object row that is already `deleting` as an explicit
resume state rather than relying on the affected-row count of a no-op UPDATE.
The retry still evaluates the live-reference guard while holding the object
claim, then retries the R2 delete so a prior R2 failure cannot strand bytes.

If an R2 object already exists but its digest index is absent or incomplete, a
retry hashes the existing R2 bytes and repairs the D1 row before deciding
whether the incoming content is an immutable duplicate or conflict.

GC uses persistent scan state and bounded pages. Deletion jobs persist the NAR
keys discovered during member processing and clean those keys in bounded
follow-up batches rather than loading a complete version into memory.

Narinfo parsing validates the core fields required for usable Nix metadata and
continues to require the referenced NAR to be present and indexed. `If-Match`
uses strong ETag comparison; invalid ranges return the standard unsatisfied
range header. Whitespace-only narinfo lines are ignored, and successful parsing
returns a non-null validated `StorePath`.

Audit writes are awaited by mutation handlers and jobs. Cache generation is
advanced before deletion starts, and structured cache/R2 events include method,
status, object kind, and byte counts where applicable. Range HEAD responses
emit the same `cache_hit` event as full-object HEAD responses.

TTL calculation treats a second-pass membership scan that finds no active
versions as unclassified, avoiding a long fallback retention TTL when a
membership disappears between the bounded scans. Existing-object PUTs also
reject a missing request body before hashing so malformed retries receive the
same `empty_body` response as first-time uploads.

Administrative deletion requests that observe a version in `registering` (or
lose the active-state race before acquiring the deletion lock) return the
distinct `version_busy` conflict instead of reporting that deletion is already
in progress.

Version metadata and pin mutations use the same state-aware conflict mapping:
they report `version_deleting` only for a deleting version and `version_busy`
when a registering or otherwise changed version loses the conditional update
race. Persistent job payload parsing also rejects JSON arrays and falls back to
the safe default object shape.

Deletion-job insertion ignores the active-job uniqueness conflict. The caller
re-reads the existing job after a conflict, so concurrent deletion requests
remain idempotent instead of surfacing a database constraint error.

The write-claim expiry cleanup is indexed by `expires_at` and rate-limited per
Worker isolate so hot upload and deletion loops do not issue a cleanup query
for every claim. A claim insert also atomically replaces an expired row for its
requested key, so cleanup amortization cannot extend that key's lock lifetime.
TTL evaluation computes retention during its bounded membership scan and uses a
separate existence check only to detect membership disappearing before the
response is formed. Administrative package search escapes SQL LIKE wildcards so
database selection and in-memory filtering use literal query semantics.

## Invariants and security

- A deleting version cannot be re-registered, patched, or pinned.
- A deleting object key cannot be overwritten or reused by an application
  upload.
- An object left in `deleting` state is independently retryable until its R2
  bytes and D1 row have been cleaned up.
- A different-content PUT never replaces an existing R2 object.
- A transient D1 indexing failure does not make a successfully stored object
  permanently unrecoverable.
- An object with no active membership after TTL evaluation receives the
  unclassified short TTL.
- A PUT without a body is rejected consistently whether or not the object key
  already exists.
- No token or authorization header is included in logs or audit details.

## Compatibility and migration

The normal Nix `PUT`, `GET`, `HEAD`, Range, and narinfo paths remain unchanged.
The migration adds persistent GC scan state, deletion-job NAR tracking, and a
unique active-delete-job index. Existing jobs remain resumable through their
existing status and payload fields.

## Acceptance tests

- Registration and patch/pin requests are rejected after deletion is queued.
- GC does not delete a version that was pinned before execution.
- Stale running jobs are reclaimed by the scheduler.
- Concurrent normal and multipart writes cannot overwrite one another.
- Existing-object retries remain mutually exclusive with an active key claim.
- A retry repairs an R2 object whose D1 index is missing or lacks a digest.
- Deleting and re-uploading the same key cannot cause the old job to delete the
  new object.
- A deletion retry removes R2 bytes when the D1 object row is already in
  `deleting` state.
- Empty-body retries and membership disappearance during TTL calculation retain
  their safe error and cache-TTL behavior.
- Deletion requests racing registration return the accurate busy conflict.
- Metadata and pin mutations report accurate conflicts while a version is
  registering or changing state.
- Concurrent deletion-job creation returns the already queued job instead of a
  database constraint error.
- Write-claim expiry cleanup is amortized and TTL evaluation remains bounded on
  hot read/write paths.
- An expired claim is immediately reclaimable for the key being requested.
- Package search preserves SQL matches for raw tag JSON formatting.
- Package search treats `%` and `_` as literal query characters.
- Narinfo core-field and dependency validation, strong `If-Match`, and 416
  `Content-Range` behavior are tested.
- Range HEAD responses preserve cache-hit observability.
- Whitespace-only narinfo lines are accepted without weakening required-field
  validation.
- Large GC/deletion work advances through bounded persistent batches.
- Legacy array-shaped job payloads fall back to the default object payload.
- Audit and metric events are emitted with the documented safe fields.

## Implementation notes

Implementation is in `src/jobs`, `src/storage/r2.ts`, `src/routes`,
`src/domain`, `src/observability.ts`, and the forward migration following the
baseline schema. The admin console's same-tab `sessionStorage` behavior is
retained by design and is documented in `AGENTS.md`.
