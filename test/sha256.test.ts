import { describe, expect, it } from "vitest";
import { Sha256 } from "../src/domain/sha256";

describe("streaming SHA-256", () => {
  it("matches the standard empty digest", () => {
    expect(new Sha256().digest()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the standard abc digest", () => {
    expect(new Sha256().update(new TextEncoder().encode("abc")).digest()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
