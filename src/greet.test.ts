import { describe, expect, it } from "vitest";
import { greet } from "./greet.ts";

describe("greet", () => {
  it("defaults to World", () => {
    expect(greet()).toBe("Hello, World!");
  });

  it("greets the given name", () => {
    expect(greet("Kevin")).toBe("Hello, Kevin!");
  });
});
