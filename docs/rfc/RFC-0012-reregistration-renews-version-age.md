# RFC-0012: re-registration renews version age

- Status: Implemented
- Date: 2026-08-20

## Context

Nix publishers routinely retry successful uploads and version registrations.
Cache object PUTs already compare the complete incoming bytes with the stored
digest: equal bytes are an idempotent success and differing bytes are rejected.
Version registration, however, retains the original `registered_at` timestamp
for an existing `(packageName, versionName)` identity. A successful retry can
therefore leave an actively republished version close to its previous GC age.

## Goals and non-goals

- Preserve immutable R2 object bytes while accepting same-content retries.
- Renew a version's `registered_at` timestamp after every successful,
  authorized complete registration.
- Make keep-latest ordering and finite retention age reflect the latest
  successful registration.

This RFC does not permit different bytes at an existing cache-object key, parse
version names, alter pin behavior, or change explicit deletion authorization.

## Design

Normal object PUT semantics remain unchanged. An existing object with the same
byte digest and size returns the idempotent success response; different content
returns the immutable conflict response.

The version registration API continues to treat each PUT as a complete
authorized declaration of membership, tags, and retention. Whether the
declaration is unchanged or updates allowed metadata/membership, a successful
registration replaces `registered_at` with the request timestamp. Its response
returns that refreshed timestamp. The existing version ID and pin state are
retained.

## Invariants and security

- Cache object bytes remain immutable after their first successful upload.
- A re-registration only succeeds after all declared narinfos and their NARs
  are ready and indexed.
- Deleting versions remain unavailable for registration.
- The existing write-role requirement, version lock, audit event, and
  no-credential logging rules remain in effect.

## Compatibility and migration

No schema migration or Nix HTTP cache protocol change is needed. Existing
clients can repeat the same PUTs. Operators should expect a successful
re-registration to renew finite retention age and keep-latest ordering.

## Acceptance tests

- Identical NAR and narinfo PUT retries remain successful, while differing
  object bytes still conflict.
- Re-registering an existing version returns HTTP 200 and a `registeredAt`
  value newer than its prior value.
- The refreshed timestamp is persisted and is used by retention ordering.
- Registration retains its existing member readiness, deletion-lock, and pin
  protections.

## Implementation notes

Implementation is in the version registration route and its integration tests.
Operator documentation records the changed timestamp semantics.
