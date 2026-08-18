import { AppError } from "./errors";

export type ByteRange = { offset: number; length: number; start: number; end: number };

export function parseRange(header: string | undefined, size: number): ByteRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size < 0) throw new AppError("invalid_range", "Only one byte range is supported", 416);
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) throw new AppError("invalid_range", "The byte range is invalid", 416);
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0 || size === 0) throw new AppError("invalid_range", "The byte range is unsatisfiable", 416);
    const length = Math.min(suffix, size);
    return { offset: size - length, length, start: size - length, end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isInteger(start) || start < 0 || start >= size) throw new AppError("invalid_range", "The byte range is unsatisfiable", 416);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isInteger(requestedEnd) || requestedEnd < start) throw new AppError("invalid_range", "The byte range is unsatisfiable", 416);
  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1, start, end };
}
