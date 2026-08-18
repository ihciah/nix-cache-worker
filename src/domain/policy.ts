import { parseTags, type VersionRow } from "../storage/db";

export const RETENTION_BASE_FIELDS = ["pkg_name", "pkg_version", "pkg_tags"] as const;
export const RETENTION_OPERATORS = ["equals", "starts_with", "ends_with", "contains"] as const;

export type RetentionBaseField = typeof RETENTION_BASE_FIELDS[number];
export type RetentionOperator = typeof RETENTION_OPERATORS[number];
export type RetentionField = RetentionBaseField | `pkg_tag:${string}`;

export type RetentionCondition = {
  field: RetentionField;
  operator: RetentionOperator;
  value: string;
  negate: boolean;
};

export type PolicyRow = {
  id: number;
  name: string;
  conditions_json: string;
  group_by_json: string;
  last_n: number | null;
  duration_days: number | null;
};

export function isRetentionField(value: string): value is RetentionField {
  return RETENTION_BASE_FIELDS.includes(value as RetentionBaseField)
    || /^pkg_tag:[A-Za-z0-9._~-]{1,64}$/.test(value);
}

export function isRetentionOperator(value: string): value is RetentionOperator {
  return RETENTION_OPERATORS.includes(value as RetentionOperator);
}

function parseConditions(value: string): RetentionCondition[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const conditions: RetentionCondition[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const condition = item as Record<string, unknown>;
      if (typeof condition.field !== "string" || !isRetentionField(condition.field)) return null;
      if (typeof condition.operator !== "string" || !isRetentionOperator(condition.operator)) return null;
      if (typeof condition.value !== "string") return null;
      if (condition.negate !== undefined && typeof condition.negate !== "boolean") return null;
      conditions.push({
        field: condition.field,
        operator: condition.operator,
        value: condition.value,
        negate: condition.negate === true,
      });
    }
    return conditions;
  } catch {
    return null;
  }
}

function parseGroupBy(value: string): RetentionField[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !isRetentionField(item))) return null;
    return parsed as RetentionField[];
  } catch {
    return null;
  }
}

export function policyConditions(policy: PolicyRow): RetentionCondition[] | null {
  return parseConditions(policy.conditions_json);
}

export function policyGroupBy(policy: PolicyRow): RetentionField[] | null {
  return parseGroupBy(policy.group_by_json);
}

function canonicalTags(tags: Record<string, string>): string {
  return Object.keys(tags).sort().map((key) => `${key}=${tags[key]}`).join(",");
}

export function retentionFieldValue(row: VersionRow, field: RetentionField): string {
  if (field === "pkg_name") return row.package_name;
  if (field === "pkg_version") return row.version_name;
  const tags = parseTags(row.tags_json);
  if (field === "pkg_tags") return canonicalTags(tags);
  return tags[field.slice("pkg_tag:".length)] ?? "";
}

function conditionMatches(value: string, condition: RetentionCondition): boolean {
  let matched: boolean;
  switch (condition.operator) {
    case "equals":
      matched = value === condition.value;
      break;
    case "starts_with":
      matched = value.startsWith(condition.value);
      break;
    case "ends_with":
      matched = value.endsWith(condition.value);
      break;
    case "contains":
      matched = value.includes(condition.value);
      break;
  }
  return condition.negate ? !matched : matched;
}

export function matchesPolicy(row: VersionRow, policy: PolicyRow): boolean {
  const conditions = policyConditions(policy);
  if (!conditions) return false;
  return conditions.every((condition) => conditionMatches(retentionFieldValue(row, condition.field), condition));
}

export function matchingPolicies(row: VersionRow, policies: PolicyRow[]): PolicyRow[] {
  return policies.filter((policy) => matchesPolicy(row, policy));
}

export function effectiveRetentionDays(row: VersionRow, policies: PolicyRow[], fallback: number): number {
  if (row.retention_days !== null) return row.retention_days;
  const values = matchingPolicies(row, policies)
    .map((policy) => policy.duration_days)
    .filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : fallback;
}

export function groupKey(row: VersionRow, fields: RetentionField[]): string {
  return JSON.stringify(fields.map((field) => [field, retentionFieldValue(row, field)]));
}

function newestFirst(rows: VersionRow[]): VersionRow[] {
  return [...rows].sort((left, right) => right.registered_at.localeCompare(left.registered_at));
}

export function isProtectedByKeepLatest(row: VersionRow, versions: VersionRow[], policies: PolicyRow[]): boolean {
  for (const policy of matchingPolicies(row, policies)) {
    const count = policy.last_n ?? 0;
    const fields = policyGroupBy(policy);
    if (count <= 0 || !fields) continue;
    const rowGroup = groupKey(row, fields);
    const candidates = newestFirst(versions.filter((candidate) => matchesPolicy(candidate, policy) && groupKey(candidate, fields) === rowGroup));
    if (candidates.slice(0, count).some((candidate) => candidate.version_id === row.version_id)) return true;
  }
  return false;
}
