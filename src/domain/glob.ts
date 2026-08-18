export function globMatches(pattern: string, value: string): boolean {
  let regex = "^";
  for (const character of pattern) {
    if (character === "*") regex += ".*";
    else if (character === "?") regex += ".";
    else regex += character.replace(/[\\^$+{}()[\].|]/g, "\\$&");
  }
  regex += "$";
  try {
    return new RegExp(regex).test(value);
  } catch {
    return false;
  }
}

export function patternSpecificity(pattern: string): number {
  return Array.from(pattern).filter((character) => character !== "*" && character !== "?").length;
}
