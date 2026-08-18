# RFC-0002: dynamic TTL for unclassified and set-associated objects

- Status: Implemented
- Date: 2026-08-17

## Context

Objects can be uploaded by a standard Nix client before CI registers an
artifact set. A long immutable cache lifetime for an unclassified object would
make an accidental upload difficult to correct and would bypass the intended
retention policy.

## Goals and non-goals

Unclassified objects must have a short six-hour HTTP cache lifetime. After set
registration, the narinfo and its referenced NAR must use the effective set
retention. The change must preserve immutable R2 bytes and standard Nix PUT
behavior. This RFC does not make R2 objects mutable and does not change GC pin
semantics.

## Design

`GET` and `HEAD` calculate `Cache-Control` at response time from D1:

1. If the object is not associated with an active artifact set, use
   `max-age=21600`.
2. If it is associated with active sets, use the longest effective retention
   among those sets.
3. A set-level `retentionDays` wins; if absent, use the system default
   `default_retention_days` setting, falling back to 30 days.
4. The association test treats both a member narinfo and its referenced NAR as
   belonging to the set.
5. NAR responses retain the `immutable` directive when their TTL is positive;
   narinfo responses remain revalidatable.

The six-hour default applies to both NAR and narinfo responses. `/nix-cache-info`
continues to use its separate five-minute TTL. `pinned` affects automatic GC
only and does not change HTTP TTL.

## Invariants and security

The Worker never rewrites R2 bytes or relies on mutable R2 metadata to apply a
new retention. If a set is updated or removed, the next Worker response uses
the new membership. If D1 has no membership, the safe short TTL is used.

## Compatibility and migration

No client or schema migration is required. Existing objects immediately use
the six-hour unclassified behavior after deployment. Existing set membership
continues to work through the new read-time query.

## Acceptance tests

- An uploaded NAR and narinfo return a six-hour TTL before registration.
- Registering the narinfo in a two-day set changes both responses to 172800
  seconds.
- Updating/removing the set changes subsequent responses without rewriting R2.
- Multiple active sets use the longest effective retention.
- Missing/default retention uses the configured system default.
- Nix GET, HEAD, Range, ETag, and conditional requests continue to work.

## Implementation notes

The implementation is in `src/storage/retention.ts`, `src/storage/r2.ts`, and
`src/domain/keys.ts`. The integration test is in `test/app.test.ts`.
