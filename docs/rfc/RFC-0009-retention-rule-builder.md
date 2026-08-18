# RFC-0009: expressive retention rules and visual rule builder

- Status: Implemented
- Date: 2026-08-18

## Context

The current retention policy model has fixed package/version glob selectors,
JSON tag matchers, a package-scoped keep-latest count, and one finite duration.
It cannot express reusable grouping dimensions such as a tag value, nor simple
operator-based conditions that are easier to review in an operations console.
The existing policy editor also exposes several narrow text fields and asks
operators to enter tag matcher JSON directly.

## Goals and non-goals

This change will:

- express a rule as `where` conditions, `group by` fields, `lastN`, and a finite
  duration in days;
- support `equals`, `starts_with`, `ends_with`, and `contains`, with optional
  negation for each condition;
- support `pkg_name`, `pkg_version`, `pkg_tags`, and `pkg_tag:<tag>` fields in
  both conditions and grouping;
- calculate last-N protection per rule and per computed group;
- provide a visual Cloudflare-style rule builder with rows, chips, selectors,
  action cards, and a live human-readable summary;
- preserve the seeded default tag-combination rule as an editable policy.

This RFC does not change Nix HTTP compatibility, version-level retention
overrides, pin semantics, object immutability, or persistent GC jobs.

## Design

### Rule representation

New policies use the following shape:

```json
{
  "name": "stable-linux-builds",
  "conditions": [
    {"field": "pkg_name", "operator": "starts_with", "value": "hello", "negate": false},
    {"field": "pkg_tag:channel", "operator": "equals", "value": "stable", "negate": false}
  ],
  "groupBy": ["pkg_name", "pkg_tag:system"],
  "lastN": 3,
  "durationDays": 30
}
```

All conditions are ANDed. An empty condition list matches every active
version. A rule must specify at least one action: `lastN` and/or
`durationDays`. Both values may be zero; zero means no keep-latest grant or an
immediate finite age threshold respectively.

The supported field names are:

- `pkg_name`: `artifact_versions.package_name`;
- `pkg_version`: `artifact_versions.version_name`;
- `pkg_tags`: a stable comma-separated string of sorted `key=value` pairs;
- `pkg_tag:<tag>`: the value of one tag, or the empty string when the tag is
  absent.

The `pkg_tags` representation is intended for string operators such as
`contains`; group keys use the same canonical value. Tag values are not split
or parsed by the operator implementation.

The `groupBy` list is ordered and may contain zero or more supported fields.
An empty list means one group containing all matching versions. A group key is
the ordered tuple of field values. `lastN` protects the newest matching
versions in each group, ordered by `registered_at DESC`. Grouping affects only
last-N protection; `durationDays` is evaluated independently for every
matching version.

### Matching and retention combination

For each active version, every matching rule contributes independently:

- last-N protection is the union of all rule grants;
- the effective finite duration is the largest matching rule duration;
- an explicit version `retentionDays` override still wins over all rule
  durations and the system default;
- if no matching rule provides a duration, the system default applies.

Migration 0004 seeds a normal policy for the newest three versions in each
exact `(packageName, complete tags)` group. It is additive while present, but
can be edited or deleted by an administrator; no code-level fallback restores
it.

There is no legacy policy representation after this change. Existing policy
rows are intentionally cleared during migration; operators must recreate them
using the structured rule builder.

### Storage and API

The `gc_policies` table is recreated with `conditions_json`, `group_by_json`,
`last_n`, and `duration_days` columns. The migration intentionally drops all
existing policy rows. The admin API accepts and returns only the structured
fields.

### Admin console

The policy section uses a visual editor:

- condition rows have field, operator, value, and a negation control;
- tag-specific fields reveal a tag-key input only when selected;
- group-by fields are displayed as removable chips with an add-field control;
- last-N and duration are separate action cards with enable toggles;
- a live summary describes the rule in plain language;
- existing policy rows are not migrated; the console only presents the new
  structured representation.

## Invariants and security

- Matching is bounded by limits on condition count, group-field count, field
  name length, and condition value length.
- No token or authorization value is included in rule data, grouping, logs, or
  cache responses.
- Rules affect automatic GC and finite HTTP TTL calculations only; they do not
  permit deletion of pinned versions by themselves.
- Shared NAR reference protection and persistent deletion-job recovery remain
  unchanged.
- Rule names remain unique and use the existing safe name character set.

## Compatibility and migration

Migration `0003` drops and recreates `gc_policies`, clearing existing policy
rows. The default retention and default keep-latest Worker variables are
unchanged.

## Acceptance tests

- Each supported field and operator matches the documented field value.
- Negated conditions invert the individual predicate and multiple conditions
  are ANDed.
- Grouping by package, version, all tags, and individual tags produces stable
  independent groups.
- A rule protects last N versions per computed group using `registered_at`.
- A rule with only duration, only lastN, or both behaves correctly.
- Overlapping structured rules union protection and use the largest duration.
- The admin API validates and round-trips structured rules.
- The admin console renders a valid rule editor without raw tag JSON input.
- HTTP TTL, pins, shared objects, and direct Nix cache behavior remain intact.

### Seeded default rule

The former code-level default protection is represented by a normal seeded
policy named `default-package-tags`:

```json
{
  "conditions": [],
  "groupBy": ["pkg_name", "pkg_tags"],
  "lastN": 3,
  "durationDays": null
}
```

It is visible in the admin console and may be edited or deleted like any other
policy. Deleting it removes that protection; no hidden fallback recreates it.

## Implementation notes

Implemented in the domain policy module, D1 migration, admin API, retention
TTL lookup, GC tests, and inline admin console. The implementation uses
`durationDays` as the explicit API name for the duration action. The default
three-version exact-tag behavior is seeded as an ordinary editable policy.
