import { describe, expect, it } from "vitest";
import {
  effectiveRetentionDays,
  groupKey,
  isProtectedByKeepLatest,
  matchesPolicy,
  retentionFieldValue,
  type PolicyRow,
} from "../src/domain/policy";
import type { VersionRow } from "../src/storage/db";

function version(id: string, packageName: string, versionName: string, tags: Record<string, string>, registeredAt: string): VersionRow {
  return {
    version_id: id,
    package_name: packageName,
    version_name: versionName,
    tags_json: JSON.stringify(tags),
    retention_days: null,
    pinned: 0,
    registered_at: registeredAt,
    updated_at: registeredAt,
    state: "active",
  };
}

function policy(id: number, conditions: unknown[], groupBy: string[], lastN: number | null, durationDays: number | null): PolicyRow {
  return {
    id,
    name: `policy-${id}`,
    conditions_json: JSON.stringify(conditions),
    group_by_json: JSON.stringify(groupBy),
    last_n: lastN,
    duration_days: durationDays,
  };
}

describe("structured retention policies", () => {
  it("has no hidden keep-latest fallback when the seeded rule is removed", () => {
    const row = version("1", "app", "1", { channel: "stable" }, "2026-08-01T00:00:00.000Z");
    expect(isProtectedByKeepLatest(row, [row], [])).toBe(false);
  });

  it("matches all fields and operators, with per-condition negation", () => {
    const row = version("1", "hello-app", "2026.08", { channel: "stable", system: "x86_64" }, "2026-08-01T00:00:00.000Z");
    const rule = policy(1, [
      { field: "pkg_name", operator: "starts_with", value: "hello" },
      { field: "pkg_version", operator: "ends_with", value: ".08" },
      { field: "pkg_tags", operator: "contains", value: "channel=stable" },
      { field: "pkg_tag:system", operator: "equals", value: "arm64", negate: true },
    ], [], null, 30);
    expect(retentionFieldValue(row, "pkg_tags")).toBe("channel=stable,system=x86_64");
    expect(matchesPolicy(row, rule)).toBe(true);
    expect(matchesPolicy({ ...row, version_name: "2026.07" }, rule)).toBe(false);
  });

  it("protects last N versions independently in each computed group", () => {
    const oldStable = version("stable-old", "app", "old", { channel: "stable" }, "2026-08-01T00:00:00.000Z");
    const newStable = version("stable-new", "app", "new", { channel: "stable" }, "2026-08-03T00:00:00.000Z");
    const beta = version("beta", "app", "beta", { channel: "beta" }, "2026-08-02T00:00:00.000Z");
    const rule = policy(1, [{ field: "pkg_name", operator: "equals", value: "app" }], ["pkg_tag:channel"], 1, 30);
    expect(groupKey(oldStable, ["pkg_tag:channel"])).not.toBe(groupKey(beta, ["pkg_tag:channel"]));
    expect(isProtectedByKeepLatest(oldStable, [oldStable, newStable, beta], [rule])).toBe(false);
    expect(isProtectedByKeepLatest(newStable, [oldStable, newStable, beta], [rule])).toBe(true);
    expect(isProtectedByKeepLatest(beta, [oldStable, newStable, beta], [rule])).toBe(true);
  });

  it("unions keep-latest grants and chooses the largest duration", () => {
    const old = version("old", "app", "old", { channel: "stable" }, "2026-08-01T00:00:00.000Z");
    const newest = version("new", "app", "new", { channel: "stable" }, "2026-08-03T00:00:00.000Z");
    const broad = policy(1, [], ["pkg_name"], 1, 30);
    const byChannel = policy(2, [{ field: "pkg_tag:channel", operator: "equals", value: "stable" }], ["pkg_tag:channel"], 2, 90);
    expect(isProtectedByKeepLatest(old, [old, newest], [broad, byChannel])).toBe(true);
    expect(effectiveRetentionDays(old, [broad, byChannel], 7)).toBe(90);
  });
});
