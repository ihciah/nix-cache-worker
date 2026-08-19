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

All application uploads acquire the per-key D1 write claim. Multipart claims
are renewed while parts are being consumed. A key with a `deleting` D1 object
row cannot be reused until deletion cleanup has completed.

If an R2 object already exists but its digest index is absent or incomplete, a
retry hashes the existing R2 bytes and repairs the D1 row before deciding
whether the incoming content is an immutable duplicate or conflict.

GC uses persistent scan state and bounded pages. Deletion jobs persist the NAR
keys discovered during member processing and clean those keys in bounded
follow-up batches rather than loading a complete version into memory.

Narinfo parsing validates the core fields required for usable Nix metadata and
continues to require the referenced NAR to be present and indexed. `If-Match`
uses strong ETag comparison; invalid ranges return the standard unsatisfied
range header.

Audit writes are awaited by mutation handlers and jobs. Cache generation is
advanced before deletion starts, and structured cache/R2 events include method,
status, object kind, and byte counts where applicable.

## Invariants and security

- A deleting version cannot be re-registered, patched, or pinned.
- A deleting object key cannot be overwritten or reused by an application
  upload.
- A different-content PUT never replaces an existing R2 object.
- A transient D1 indexing failure does not make a successfully stored object
  permanently unrecoverable.
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
- A retry repairs an R2 object whose D1 index is missing or lacks a digest.
- Deleting and re-uploading the same key cannot cause the old job to delete the
  new object.
- Narinfo core-field and dependency validation, strong `If-Match`, and 416
  `Content-Range` behavior are tested.
- Large GC/deletion work advances through bounded persistent batches.
- Audit and metric events are emitted with the documented safe fields.

## Implementation notes

Implementation is in `src/jobs`, `src/storage/r2.ts`, `src/routes`,
`src/domain`, `src/observability.ts`, and the forward migration following the
baseline schema. The admin console's same-tab `sessionStorage` behavior is
retained by design and is documented in `AGENTS.md`.
