import { AppError } from "./errors";
import { kindForKey } from "./keys";

export type ParsedNarInfo = {
  narKey: string;
  storePath: string;
};

export function parseNarInfo(text: string): ParsedNarInfo {
  const fields = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new AppError("invalid_narinfo", "The narinfo contains a malformed field", 422);
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (fields.has(name)) throw new AppError("invalid_narinfo", `The narinfo contains a duplicate ${name} field`, 422);
    fields.set(name, value);
  }
  const requiredFields = ["URL", "StorePath", "Compression", "FileHash", "FileSize", "NarHash", "NarSize", "References"];
  if (requiredFields.some((field) => !fields.has(field))) {
    throw new AppError("invalid_narinfo", "The narinfo is missing a required field", 422);
  }
  const rawUrl = fields.get("URL") ?? "";
  let narKey: string;
  try {
    narKey = decodeURIComponent(rawUrl).replace(/^\/+/, "");
  } catch {
    throw new AppError("invalid_narinfo", "The narinfo URL is not valid UTF-8", 422);
  }
  if (narKey.includes("..")) {
    throw new AppError("invalid_narinfo", "The narinfo URL must not contain '..'", 422);
  }
  try {
    if (kindForKey(narKey) !== "nar") throw new Error("not-nar");
  } catch {
    throw new AppError("invalid_narinfo", "The narinfo URL must reference a /nar/ object", 422);
  }
  const storePath = fields.get("StorePath");
  if (!storePath || !storePath.startsWith("/nix/store/") || !/^\d+$/.test(fields.get("FileSize") ?? "") || !/^\d+$/.test(fields.get("NarSize") ?? "")) {
    throw new AppError("invalid_narinfo", "The narinfo contains invalid store or size fields", 422);
  }
  if (!fields.get("Compression") || !fields.get("FileHash") || !fields.get("NarHash")) {
    throw new AppError("invalid_narinfo", "The narinfo contains an empty required value", 422);
  }
  return { narKey, storePath };
}
