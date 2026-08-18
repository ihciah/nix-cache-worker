# RFC-0005: hierarchical package/version artifacts and version-scoped retention

- Status: Implemented
- Date: 2026-08-17

## Context

The current artifact-set model is flat. `artifact_sets` has one row per
`setName`, and `artifact_set_members` attaches multiple narinfo keys directly
to that row. The `version` value, when present, is only an arbitrary tag. The
Worker therefore has no first-class package identity, build-version identity,
or version-to-file hierarchy.

This model differs from the intended operator model:

| Concern | Current behavior | Intended behavior |
| --- | --- | --- |
| Organization | One flat artifact set contains many narinfos | Package contains versions; each version contains multiple cache files |
| Version identity | Optional `version` tag; not an entity | Required build-version identity within a package |
| Retention unit | Whole artifact set | Individual build version |
| Keep-latest scope | Set rows grouped by `retentionGroup`, `software`, or `setName` | Matching versions counted independently within each package |
| Ordering | `registered_at` orders set rows; repeated registration currently refreshes it | `registered_at` orders versions and is preserved after an idempotent update |
| Pin target | Artifact set | Build version |
| Delete target | Artifact set and all its members | Build version and its files only |
| Admin display | A flat table of sets, tags, members, and bytes | Package rows expanded into version rows, then file rows |

The current management API reflects the flat model. CI registers a complete
set with `PUT /api/sets/{setName}`, while the admin API, pin endpoints, delete
jobs, and GC jobs all use `setName` as their target. GC policies match a set
name glob and tags, and `keepLatest` is not a version-aware retention rule.

The standard Nix cache protocol and the immutable R2 object model are not the
source of this mismatch. The change is in artifact metadata, retention
evaluation, management APIs, background jobs, and the admin console.

This RFC supersedes the artifact-set semantics in RFC-0001, the set-association
parts of RFC-0002, and the set-oriented management surface described by
RFC-0003. It does not change the public Nix cache paths or upload protocol.

## Goals and non-goals

### Goals

- Model the hierarchy explicitly as package -> build version -> files.
- Make a build version the unit of retention, pinning, deletion, and audit
  targeting.
- Allow a selector to protect the newest `N` matching versions independently
  for each package.
- Apply a finite retention duration to versions not protected by a matching
  keep-latest rule.
- Present packages, their versions, and each version's files in that hierarchy
  in the admin console.
- Preserve immutable R2 bytes, shared-NAR protection, standard Nix client
  compatibility, and bounded resumable jobs.

### Non-goals

- Parsing, comparing, or sorting semantic-version strings. Version labels may
  be arbitrary strings; “latest” is still determined by `registered_at`.
- Building packages, scheduling builds, or changing CI's build pipeline beyond
  the metadata registration API.
- Adding package-level pin or delete operations. A package is an organizing
  container, not a destructive target.
- Replacing the standard Nix PUT protocol with a custom client upload protocol.
- Rewriting R2 object bytes or making an existing cache object mutable.

## Design

### Terminology and identities

- A **package** is a stable package name such as `hello`. It groups versions
  and has no retention, pin, or delete state of its own.
- A **version** is one build identity within a package. Its external identity
  is `(packageName, versionName)`, and its internal identity is an immutable
  `versionId`. `versionName` is required, opaque, and must not be interpreted
  as a sortable software version.
- A **file** is a logical cache member of a version. The membership edge points
  to a narinfo key; the narinfo's indexed `narinfo_refs` row identifies its NAR
  payload. The admin UI may display these as separate narinfo and NAR file
  rows, while the database keeps the NAR relationship normalized and shared.
- `/nix-cache-info` and other objects that are not members of a live version
  remain unclassified cache objects.

A version identity is immutable. Re-registering the same package and version
may update its tags, retention override, and complete file membership, but it
must preserve the original `registered_at`. Publishing a new build version
creates a new version identity.

### Storage model

The forward-only D1 migration should introduce the following logical schema:

```text
artifact_packages
  package_name PRIMARY KEY
  created_at
  updated_at

artifact_versions
  version_id PRIMARY KEY
  package_name REFERENCES artifact_packages(package_name)
  version_name
  tags_json
  retention_days NULLABLE
  pinned
  registered_at
  updated_at
  state
  UNIQUE(package_name, version_name)

artifact_version_members
  version_id REFERENCES artifact_versions(version_id)
  narinfo_key REFERENCES narinfo_refs(narinfo_key)
  PRIMARY KEY(version_id, narinfo_key)
```

The existing `objects`, `narinfo_refs`, `jobs`, and `audit_log` tables remain
the source of object metadata, dependency references, job state, and audit
history. `artifact_version_members` is the ownership edge; a NAR is not copied
into every version. A narinfo or NAR may be shared by multiple live versions
when the metadata permits it, and deletion must preserve both kinds of shared
objects.

The existing `artifact_sets` tables may remain during migration for rollback
and audit purposes, but new code must use version tables as the source of
truth after cutover. No new feature may add another set-level retention or
pin field.

### Registration API

The canonical CI registration endpoint becomes:

```http
PUT /api/packages/{packageName}/versions/{versionName}
Authorization: Bearer <write-token>
Content-Type: application/json
```

Example:

```json
{
  "narinfoKeys": ["<hash-a>.narinfo", "<hash-b>.narinfo"],
  "tags": {
    "channel": "stable",
    "system": "x86_64-linux"
  },
  "retentionDays": 30
}
```

The endpoint must:

1. Validate both path components as bounded URL-safe single segments.
2. Require at least one indexed, ready narinfo whose referenced NAR is also
   present and indexed.
3. Upsert the package and version metadata transactionally enough that a
   partially registered version is never visible as live.
4. Replace the version's complete member declaration idempotently, without
   replacing any R2 object bytes.
5. Preserve `registered_at` on an existing `(packageName, versionName)` and
   update only `updated_at`.

The old `PUT /api/sets/{setName}` endpoint is not a valid long-term write
contract because an arbitrary set name cannot identify both a package and a
version. A transition adapter may remain temporarily, but it must either
require explicit package and version fields or return a migration error. It
must not silently infer a hierarchy that could merge unrelated builds.

### Retention selectors

`gc_policies` becomes a collection of version selectors. The public policy
shape is:

```json
{
  "name": "stable-hello",
  "selector": {
    "packageGlob": "hello",
    "versionGlob": "*",
    "tagMatchers": {"channel": "stable"}
  },
  "keepLatestVersions": 3,
  "retentionDays": 30
}
```

`versionGlob` is optional. `packageGlob`, the optional version glob, and all
tag matchers must match for a version to be selected. Glob matching remains
bounded and literal-safe as in the existing policy implementation.

For every matching policy, the Worker:

- Groups the selected versions by `package_name`, never by a tag fallback.
- Orders each package's selected versions by `registered_at DESC` and protects
  the first `keepLatestVersions` versions from automatic GC.
- Uses the largest `retentionDays` among matching policies as the finite
  duration for the version, unless the version has an explicit
  `retentionDays` override.

The protection result is the union of all matching keep-latest grants. This is
deliberately fail-safe when selectors overlap: a broad rule cannot silently
remove a version protected by a more specific rule. `keepLatestVersions: 0`
grants no persistent protection. If no selector supplies a duration, the
system default applies.

The age clock for time-based retention starts at the version's
`registered_at`. A version that is protected by keep-latest or pinning is not
eligible for automatic GC regardless of age. These GC protections do not
change the HTTP cache TTL; cache responses continue to use a finite effective
retention value.

An explicit version `retentionDays` is an exception for that version's finite
retention duration. It does not create a package-level rule and does not
override keep-latest or pin protection.

### Garbage collection and deletion

GC evaluates live versions, not packages. A candidate version is eligible only
when all of the following are true:

- it is not pinned;
- it is not in the protected keep-latest result of any matching selector; and
- its age is at least its effective retention duration.

GC enqueues a resumable `delete_version` job with `target_version_id`. The job
must:

- mark only the target version as deleting;
- process its member files in bounded batches;
- delete a narinfo only when no other live version still references it; and
- delete a NAR only when no live narinfo still references it.

After the version is deleted, its package and other versions remain available.
An empty package is metadata only and is not a delete target; cleanup of empty
package rows, if desired, is a separate non-destructive metadata operation.

Manual deletion is also version-scoped. The admin request must confirm the
fully qualified package/version target, require a reason, and record the
version identity and reason in `audit_log`. An explicitly confirmed manual
deletion may remove a pinned version; pin protects automatic GC only.

Jobs must use `target_version_id` and be idempotent across retries. Existing
jobs that still contain `target_set` must be translated during migration before
the new runner is enabled; they must not be interpreted as package deletions.

### HTTP cache TTL

The read-time TTL design from RFC-0002 remains, with version membership
replacing set membership:

1. An unclassified object uses the existing short TTL.
2. A narinfo or referenced NAR associated with one or more live versions uses
   the longest effective finite retention among those versions.
3. Pinning and keep-latest protection affect automatic GC only and do not add
   an infinite `Cache-Control` lifetime.

This preserves safe behavior for shared objects and avoids mutating immutable
R2 metadata when a version is registered, updated, pinned, or deleted.

### Admin API and console

The canonical management surface becomes package- and version-oriented. At a
minimum it must provide:

```text
GET    /api/admin/packages
GET    /api/admin/packages/{packageName}
GET    /api/admin/packages/{packageName}/versions/{versionName}
PATCH  /api/admin/packages/{packageName}/versions/{versionName}
PUT    /api/admin/packages/{packageName}/versions/{versionName}/pin
DELETE /api/admin/packages/{packageName}/versions/{versionName}/pin
DELETE /api/admin/packages/{packageName}/versions/{versionName}
```

The list response must expose nested data or an equivalent stable parent/child
shape:

```json
{
  "packageName": "hello",
  "versions": [
    {
      "versionName": "2.12.1",
      "registeredAt": "2026-08-17T00:00:00.000Z",
      "tags": {"channel": "stable"},
      "fileCount": 2,
      "bytes": 123456,
      "pinned": false,
      "files": [
        {"kind": "narinfo", "key": "<hash>.narinfo"},
        {"kind": "nar", "key": "nar/<hash>.nar"}
      ]
    }
  ]
}
```

The `/admin` page must render:

1. package rows with version counts and aggregate bytes;
2. expandable version rows with version name, tags, registration time,
   retention state, pin state, file count, and bytes; and
3. an expandable read-only file view for each version.

Pin, unpin, retention editing, and delete controls must be placed on version
rows and must address the fully qualified version endpoint. Package rows may
support search, expansion, and aggregate inspection, but must not offer pin or
delete actions. The policy editor must display package/version selector fields
and `keepLatestVersions`, not set-oriented wording.

Overview counters must distinguish packages, versions, pinned versions, cache
objects, and unclassified objects. A flat set count may be retained only as a
legacy migration metric and must not be the primary admin hierarchy.

## Invariants and security

- R2 remains the source of truth for cache object bytes; D1 remains the source
  of artifact hierarchy and retention metadata.
- A version registration cannot expose an unindexed narinfo or missing NAR.
- Object bytes remain immutable. Same-content retries are idempotent and
  different-content writes conflict.
- A shared narinfo or NAR must remain available while any live version still
  references it.
- Package names, version names, tags, selector values, and audit targets must
  be bounded and validated. They must not be used to smuggle credentials into
  logs or URLs.
- Worker Secrets, Authorization headers, and raw bearer values remain excluded
  from source, D1, URLs, browser persistence, and logs.
- Anonymous cache reads and authenticated write/admin permissions remain
  unchanged. Standard `GET`, `HEAD`, Range, ETag, conditional requests, and
  ordinary Nix PUT behavior remain unchanged.
- Pinning is an automatic-GC protection only. Confirmed manual deletion is the
  sole path that may remove a pinned version.
- All deletion and GC jobs are bounded, retryable, and resumable after Worker
  interruption.

## Compatibility and migration

### Metadata reset

Existing metadata is intentionally disposable for this rollout. Migration
`0002_package_version_reset.sql` drops the old set tables, object indexes,
policies, jobs, settings, and audit records, then creates the package/version
schema from empty state. It performs no set-to-version mapping and does not
attempt to preserve old retention or pin state.

R2 bytes are not deleted by a D1 SQL migration. If the operator also wants the
bucket physically empty, it must be cleared separately through the Cloudflare
R2 operation before cutover. Any bytes left behind have no D1 index and are
therefore treated as unclassified until explicitly re-uploaded and registered.

### API and UI transition

The new package/version registration endpoint is the canonical CI contract.
Existing CI clients using `/api/sets/{setName}` need to be migrated to send
explicit package and version identities. A temporary compatibility endpoint
may expose a read-only legacy projection or reject writes with a migration
message, but it must not represent a package-wide operation as a version
operation without an explicit mapping.

The standard Nix cache protocol has no migration requirement. Existing Nix
clients continue to upload and download the same `/nar/*`, `.narinfo`, and
`/nix-cache-info` paths.

The implementation must update `README.md`, `docs/architecture.md`, and
`docs/configuration.md` so that they describe package/version registration,
version-scoped retention, version-targeted operations, and the nested admin
view. The repository architecture instructions must also be updated when the
implementation changes the current artifact-set invariants.

## Acceptance tests

- Registering `(packageName, versionName)` creates one package and one version
  with multiple file members; registering it again is idempotent and preserves
  `registered_at`.
- Two versions of one package and one version of another package are rendered
  as two package rows with the correct nested version and file rows.
- Version labels that are not semantic versions are accepted and are never
  parsed for ordering.
- A selector keeps the newest `N` matching versions per package, not the
  newest versions globally and not versions from another package.
- Overlapping selectors produce the union of persistent keep-latest protection;
  finite retention uses the longest matching policy unless a version override
  is present.
- Versions outside the protected set become GC candidates only after their
  effective retention duration, while pinned and protected versions do not.
- A pin, unpin, confirmed delete, audit record, and delete job all target a
  version identity; deleting one version leaves sibling versions intact.
- Shared narinfo and shared NAR objects survive deletion of one version and
  are removed only after all live references are gone.
- Read-time TTL uses version membership and remains safe for unclassified and
  shared objects.
- The admin API and page expose package -> version -> file hierarchy and place
  all destructive/protective actions on version rows.
- Legacy migration preserves bytes, members, pinned state, retention, and
  registration timestamps, and produces an actionable report for ambiguous
  package/version and keep-latest mappings.
- Anonymous, read-token, write-token, admin-token, Nix netrc/Basic, all Nix
  cache HTTP semantics, structured logs, and credential-leakage protections
  remain covered by the existing baseline tests.

## Implementation notes

The implementation is delivered through migration `0002`, the package/version
registration and admin routes, version-scoped TTL and GC logic, the nested
admin console, synchronized documentation, and the updated integration tests.
The implementation deliberately uses a destructive empty-state reset instead
of the data-preserving mapping originally considered for this RFC, as allowed
by the rollout requirement. Version file details are returned by the version
detail endpoint while package lists return version summaries to keep the admin
list bounded. R2 physical cleanup remains an operator-side bucket operation;
the D1 reset intentionally does not issue destructive R2 commands.
