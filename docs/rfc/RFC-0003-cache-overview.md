# RFC-0003: cache overview for direct Nix uploads

- Status: Implemented
- Date: 2026-08-17

## Context

The management console originally displayed artifact-set counts only. A direct
`nix copy --to` upload is valid and useful, but it does not create an artifact
set, so an operator could see zero and incorrectly conclude that the cache was
empty.

## Design

Add an authenticated `GET /api/admin/overview` endpoint with aggregate counts
for active artifact sets, pinned sets, ready cache objects, NARs, narinfos,
indexed bytes, and objects not associated with an active set. The UI displays
artifact sets and cache objects as separate metrics and explains unclassified
objects when the set table is empty.

The overview is aggregate-only; it does not expose object bodies, tokens, or
new mutation capabilities. Object and byte totals are calculated from D1's
ready index, while set membership is used to identify unclassified objects.

## Compatibility and security

The endpoint requires the admin role. The admin console keeps a validated token
only in same-origin `sessionStorage` for the current browser tab. Existing set
APIs and the public cache protocol are unchanged.

## Acceptance tests

- Direct Nix uploads produce non-zero cache-object and byte counts even when
  artifact-set count is zero.
- Registered sets and pinned-set counts are reported separately.
- Unclassified object counts explain why the set table may be empty.
- Aggregate queries do not include deleted object rows.

## Implementation notes

The endpoint is implemented in `src/routes/admin.ts` and the UI is rendered by
`src/ui/admin.ts`.
