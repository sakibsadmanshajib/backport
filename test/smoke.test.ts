import { versions } from "node:process";
// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("runs on Node 24 or newer", () => {
    expect(Number(versions.node.split(".")[0])).toBeGreaterThanOrEqual(24);
  });
});
