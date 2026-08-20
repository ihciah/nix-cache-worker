# RFC-0011: admin retention remaining-time display

- Status: Implemented
- Date: 2026-08-20

## Context

The admin package table currently displays only a version's effective finite
retention duration, for example `3 days`. Operators can mistake that value for
the time still remaining before the version is eligible for garbage collection.

## Goals and non-goals

- Show both the effective finite retention duration and the remaining time in
  the admin package table.
- Keep `persistent` for pinned and keep-latest-protected versions.
- Use the same registration-time age clock as automatic GC.

This RFC does not alter retention policy evaluation, GC eligibility, object
TTL, or the public Nix cache API.

## Design

For a finite version, the admin API continues to provide the duration as the
`retentionState` field and additionally provides `retentionRemainingDays`. The
admin page renders them on separate lines as `<duration> days` and
`<remaining> days left`. Remaining days are the number of 24-hour periods until
`registered_at + effectiveRetentionDays`, rounded up so that a version with any
positive time remaining is not displayed as already eligible. A value of zero
means the version is eligible by its finite age threshold, subject to normal GC
job execution.

Pinned and keep-latest-protected versions continue to return `persistent`,
because their automatic-GC protection has no finite expiry.

## Invariants and security

- The display is derived solely from existing version metadata and effective
  retention policy evaluation.
- It does not change the GC decision or disclose credentials.

## Compatibility and migration

No storage migration or Nix HTTP behavior change is required. The authenticated
admin API gains the display-only `retentionRemainingDays` field.

## Acceptance tests

- A finite three-day version with roughly 36 hours elapsed displays `3 days`
  followed by `2 days left` on the next line.
- A pinned or keep-latest-protected version still displays `persistent`.

## Implementation notes

Implemented in the admin API and console. Finite version summaries now include
`retentionRemainingDays`; the console renders it below `retentionState` with a
line break. No policy, GC, schema, or cache protocol behavior changed.
