// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import {
  modelMessageSchema,
  resolutionDecisionSchema,
  reviewDecisionSchema,
} from "../../src/ai/schema.js";

const resolvedDecision = {
  assumptions: [],
  decision: "resolved",
  files: [
    {
      content: "export enum Status {\n  Active,\n}\n",
      path: "status.ts",
      reason: "Preserve the enum member on the older branch.",
    },
  ],
  risks: [],
  summary: "Added the missing enum member.",
} as const;

describe("resolutionDecisionSchema", () => {
  it("accepts a resolved decision", () => {
    expect(resolutionDecisionSchema.parse(resolvedDecision)).toEqual(
      resolvedDecision,
    );
  });

  it("accepts an escalation without files", () => {
    const decision = {
      assumptions: [],
      decision: "escalate",
      files: [],
      risks: ["The destination branch uses different business behavior."],
      summary: "A developer must choose the intended behavior.",
    };

    expect(resolutionDecisionSchema.parse(decision)).toEqual(decision);
  });

  it("rejects unknown fields", () => {
    expect(
      resolutionDecisionSchema.safeParse({
        ...resolvedDecision,
        confidence: 0.99,
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate file paths", () => {
    expect(
      resolutionDecisionSchema.safeParse({
        ...resolvedDecision,
        files: [
          ...resolvedDecision.files,
          { ...resolvedDecision.files[0], reason: "Duplicate output." },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects files on escalation", () => {
    expect(
      resolutionDecisionSchema.safeParse({
        ...resolvedDecision,
        decision: "escalate",
      }).success,
    ).toBe(false);
  });

  it("rejects a resolved decision without files", () => {
    expect(
      resolutionDecisionSchema.safeParse({
        ...resolvedDecision,
        files: [],
      }).success,
    ).toBe(false);
  });
});

describe("reviewDecisionSchema", () => {
  it("accepts an approval", () => {
    const review = {
      decision: "approve",
      findings: [],
      summary: "The adaptation is narrow and preserves source intent.",
    };

    expect(reviewDecisionSchema.parse(review)).toEqual(review);
  });

  it("requires findings for a rejection", () => {
    expect(
      reviewDecisionSchema.safeParse({
        decision: "reject",
        findings: [],
        summary: "The resolution is unsafe.",
      }).success,
    ).toBe(false);
  });
});

describe("modelMessageSchema", () => {
  it("accepts provider-neutral user and assistant messages", () => {
    expect(
      modelMessageSchema.array().parse([
        { content: "Resolve this conflict.", role: "user" },
        { content: "Structured response follows.", role: "assistant" },
      ]),
    ).toHaveLength(2);
  });

  it("rejects provider-specific roles", () => {
    expect(
      modelMessageSchema.safeParse({
        content: "Provider-specific instruction.",
        role: "developer",
      }).success,
    ).toBe(false);
  });
});
