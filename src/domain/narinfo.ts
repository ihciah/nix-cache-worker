import { AppError } from "./errors";

export type ParsedNarInfo = {
  narKey: string;
  storePath: string | null;
};

export function parseNarInfo(text: string): ParsedNarInfo {
  const urlLine = text.split(/\r?\n/).find((line) => line.startsWith("URL:"));
  if (!urlLine) throw new AppError("invalid_narinfo", "The narinfo does not contain a URL field", 422);
  const rawUrl = urlLine.slice(4).trim();
  let narKey: string;
  try {
    narKey = decodeURIComponent(rawUrl).replace(/^\/+/, "");
  } catch {
    throw new AppError("invalid_narinfo", "The narinfo URL is not valid UTF-8", 422);
  }
  if (!narKey.startsWith("nar/") || narKey.includes("..")) {
    throw new AppError("invalid_narinfo", "The narinfo URL must reference a /nar/ object", 422);
  }
  const storeLine = text.split(/\r?\n/).find((line) => line.startsWith("StorePath:"));
  return { narKey, storePath: storeLine ? storeLine.slice("StorePath:".length).trim() || null : null };
}
