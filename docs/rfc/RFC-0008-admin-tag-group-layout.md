# RFC-0008: admin tag-group layout

- Status: Implemented
- Date: 2026-08-18

## Context

The admin console currently lists versions directly beneath each package. A
package with many tag combinations is difficult to inspect because related
versions are mixed together.

## Goals and non-goals

Add a client-side layout toggle that groups versions within each package by
their complete tag set. The toggle is enabled by default and each tag group
can be expanded independently. Turning the toggle off restores the existing
package-to-version layout.

This change does not alter API requests, package/version membership, tags,
retention behavior, mutation actions, or server-side ordering.

## Design

Add an `aria-pressed` button labeled `Group by tags` to the packages toolbar.
The button changes only local UI state and re-renders the already loaded
package data. When enabled, each package renders a collapsible row for every
distinct complete tag set, followed by that group's version rows and file
detail rows. Tag keys are sorted before forming the group identity so
equivalent tag objects use the same group regardless of object key order. A
version with no tags is placed in a `No tags` group.

Package expansion remains the outer level. Opening a package reveals its tag
groups; opening a tag group reveals its versions. When grouping is disabled,
package expansion directly reveals version rows as before. Re-rendering after
changing the toggle resets the display expansion state without changing data.

## Invariants and security

The feature is presentation-only. It sends no new requests, stores no new
credentials, and does not change authorization or cache behavior. Existing
version actions continue to target the same `(packageName, versionName)`.

## Compatibility and migration

No HTTP endpoint, D1 schema, R2 object, deployment binding, or persisted data
changes. Existing operators see grouping enabled after deployment and can
disable it with the toolbar button.

## Acceptance tests

- The toolbar contains a tag-group toggle enabled by default.
- Toggling the button changes only the rendered package list layout.
- Grouping is scoped within each package and uses the complete tag set.
- Empty tag sets appear under `No tags`.
- Tag groups can be expanded and collapsed independently.
- Disabling grouping restores direct package-to-version rows.
- Existing admin API tests and mutation actions remain unchanged.

## Implementation notes

The static console is rendered by `src/ui/admin.ts`; the page contract checks
and inline-script syntax check are in `test/app.test.ts`. The implementation
uses a default-on `Group by tags` toggle, sorts tag keys for stable complete-tag
group identities, and keeps package/group expansion entirely client-side.
