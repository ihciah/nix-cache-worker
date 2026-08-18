# RFC-0006: default version retention and tag-combination keep-latest protection

- Status: Implemented
- Date: 2026-08-17

## Context

RFC-0005 introduced version-scoped retention and selector-driven
`keepLatestVersions`, but the implementation only had a finite default
retention duration and no default persistent version protection. The desired
operating policy is:

- unoverridden versions use a seven-day retention duration; and
- every package name plus exact tag combination keeps its three newest versions
  protected from automatic GC by default.

This protects independent build variants, such as different systems or
channels, from competing for one package-wide keep-latest quota.

## Goals and non-goals

### Goals

- Change the system default finite retention from 30 days to 7 days.
- Protect the newest three active versions for every `(packageName, tags)`
  combination by default.
- Keep explicit selector protection and the default protection safe when both
  apply.
- Preserve `registered_at` ordering and opaque version names.
- Keep the existing Nix HTTP protocol, version-level pinning, and deletion
  semantics unchanged.

### Non-goals

- Parsing version strings or defining semantic-version ordering.
- Adding a package-level pin or delete operation.
- Automatically changing an operator's explicit retention policy values.
- Treating tag keys as ordered; tag combinations are canonicalized by sorted
  tag key and exact string value.

## Design

The built-in default keep-latest group key is the package name plus a canonical
JSON representation of the complete version tag object. `{}` is a valid tag
combination. Two versions are in the same default group only when their
package names and all tag keys and values are identical.

For each default group, active versions are sorted by `registered_at DESC` and
the first three are protected from automatic GC. Explicit selector policies
continue to provide additional keep-latest protection; the final protection
result is the union of default-group and selector grants. The default grant is
intentionally fail-safe and cannot be reduced by a selector with a smaller
count.

The effective finite retention remains:

1. an explicit version `retentionDays` override;
2. the largest matching selector retention; or
3. the system default of 7 days.

Keep-latest and pin protection affect automatic GC only. They do not turn the
HTTP `Cache-Control` lifetime into an infinite value.

The default count is exposed as `DEFAULT_KEEP_LATEST_VERSIONS` with a default
value of `3`, allowing deployments to make the operational default explicit
without storing a credential or requiring a schema change.

## Invariants and security

- Default protection is evaluated per package and exact complete tag object,
  never across unrelated packages or tag variants.
- Version ordering uses `registered_at`, never version parsing.
- A protected version is not automatically deleted, but an explicitly
  confirmed administrator deletion may still remove it.
- R2 bytes remain immutable and shared narinfo/NAR reference protection is
  unchanged.
- No token, authorization header, or secret is included in retention grouping,
  logs, or responses.

## Compatibility and migration

No data migration is required. Existing package/version metadata immediately
uses the new defaults after deployment. The D1 reset rollout already specified
by RFC-0005 remains valid.

The default retention value in Wrangler configuration changes from `30` to
`7`, and the new default keep-latest value is added as a non-secret Worker
variable. Existing explicit version and policy values continue to take effect.

## Acceptance tests

- A version with no explicit retention and no matching policy uses a seven-day
  finite retention value.
- Four versions with the same package name and identical tags protect the
  newest three and leave the oldest eligible after seven days.
- Versions with different package names or any different tag key/value are in
  separate default groups.
- An untagged version group is handled as the exact `{}` tag combination.
- Explicit selector keep-latest protection is additive to the default group
  protection.
- HTTP TTL, pinning, manual deletion, shared-object protection, and standard
  Nix cache behavior remain unchanged.

## Implementation notes

Implemented in `src/domain/policy.ts`, `src/jobs/runner.ts`,
`src/storage/retention.ts`, Wrangler defaults, documentation, and integration
tests. The default group uses a canonical sorted-tag key and the configured
default count of three.
