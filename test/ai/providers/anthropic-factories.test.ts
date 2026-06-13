import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { Anthropic } from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth } from "google-auth-library";
// eslint-disable-next-line import/no-extraneous-dependencies
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicFamilyProvider,
  bedrockClientFactory,
  compatibleClientFactory,
  nativeClientFactory,
  vertexClientFactory,
} from "../../../src/ai/providers/anthropic.js";
import { structuredRequest } from "../../helpers/fakes.js";

vi.mock("@anthropic-ai/sdk", () => {
  const Anthropic = vi.fn(() => ({
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: { answer: "resolved" },
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    },
  }));
  return { Anthropic };
});

vi.mock("@anthropic-ai/bedrock-sdk", () => {
  const AnthropicBedrock = vi.fn(() => ({
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: { answer: "resolved" },
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    },
  }));
  return { AnthropicBedrock };
});

vi.mock("@anthropic-ai/vertex-sdk", () => {
  const AnthropicVertex = vi.fn(() => ({
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: { answer: "resolved" },
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    },
  }));
  return { AnthropicVertex };
});

vi.mock("google-auth-library", () => {
  const GoogleAuth = vi.fn();
  return { GoogleAuth };
});

const MockAnthropic = vi.mocked(Anthropic);
const MockAnthropicBedrock = vi.mocked(AnthropicBedrock);
const MockAnthropicVertex = vi.mocked(AnthropicVertex);
const MockGoogleAuth = vi.mocked(GoogleAuth);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("nativeClientFactory", () => {
  it("constructs Anthropic with apiKey and request options", () => {
    const factory = nativeClientFactory("sk-native-key");
    const client = factory({ maxRetries: 0, timeout: 5000 });

    expect(MockAnthropic).toHaveBeenCalledOnce();
    expect(MockAnthropic).toHaveBeenCalledWith({
      apiKey: "sk-native-key",
      maxRetries: 0,
      timeout: 5000,
    });
    expect(client).toHaveProperty("messages.parse");
  });

  it("delegates parse calls through to the SDK instance", async () => {
    const factory = nativeClientFactory("sk-native-key");
    const client = factory({ maxRetries: 0, timeout: 5000 });

    const provider = new AnthropicFamilyProvider({
      clientFactory: () => client,
      model: "claude-test",
      secrets: ["sk-native-key"],
    });

    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ ok: true });
  });

  it("normalizes null usage fields from the real parse response", async () => {
    const sdkInstance = {
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: { answer: "ok" },
          stop_reason: "end_turn",
          usage: {
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            input_tokens: null,
            output_tokens: 4,
          },
        }),
      },
    };
    MockAnthropic.mockReturnValueOnce(sdkInstance as never);

    const factory = nativeClientFactory("sk-null-usage");
    const client = factory({ maxRetries: 0, timeout: 5000 });

    const provider = new AnthropicFamilyProvider({
      clientFactory: () => client,
      model: "claude-test",
      secrets: [],
    });

    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({
      ok: true,
      usage: { inputTokens: 0, outputTokens: 4 },
    });
  });
});

describe("compatibleClientFactory", () => {
  it("constructs Anthropic with apiKey and baseURL", () => {
    const factory = compatibleClientFactory(
      "sk-compat-key",
      "https://proxy.example.test/v1",
    );
    factory({ maxRetries: 0, timeout: 3000 });

    expect(MockAnthropic).toHaveBeenCalledOnce();
    expect(MockAnthropic).toHaveBeenCalledWith({
      apiKey: "sk-compat-key",
      baseURL: "https://proxy.example.test/v1",
      maxRetries: 0,
      timeout: 3000,
    });
  });

  it("returns a working client that parses structured output", async () => {
    const factory = compatibleClientFactory(
      "sk-compat-key",
      "https://proxy.example.test/v1",
    );
    const client = factory({ maxRetries: 0, timeout: 3000 });

    const provider = new AnthropicFamilyProvider({
      clientFactory: () => client,
      model: "claude-compat-test",
      secrets: ["sk-compat-key"],
    });

    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ ok: true });
  });
});

describe("bedrockClientFactory", () => {
  it("constructs AnthropicBedrock with region only (credential-chain path)", () => {
    const factory = bedrockClientFactory({ region: "us-east-1" });
    factory({ maxRetries: 0, timeout: 4000 });

    expect(MockAnthropicBedrock).toHaveBeenCalledOnce();
    const callArgs = MockAnthropicBedrock.mock.calls[0]?.[0] as {
      [key: string]: unknown;
    };
    expect(callArgs).toMatchObject({ awsRegion: "us-east-1" });
    expect(callArgs).not.toHaveProperty("providerChainResolver");
  });

  it("constructs AnthropicBedrock with providerChainResolver when explicit keys provided", async () => {
    const factory = bedrockClientFactory({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      region: "eu-west-1",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    factory({ maxRetries: 0, timeout: 4000 });

    expect(MockAnthropicBedrock).toHaveBeenCalledOnce();
    const callArgs = MockAnthropicBedrock.mock.calls[0]?.[0] as {
      [key: string]: unknown;
    };
    expect(callArgs).toMatchObject({ awsRegion: "eu-west-1" });
    expect(callArgs).toHaveProperty("providerChainResolver");

    type Credentials = { accessKeyId: string; secretAccessKey: string };
    const resolver = callArgs.providerChainResolver as () => Promise<
      () => Promise<Credentials>
    >;
    const innerFn = await resolver();
    const credentials = await innerFn();
    expect(credentials).toEqual({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
  });

  it("includes sessionToken in credentials when provided", async () => {
    const factory = bedrockClientFactory({
      accessKeyId: "AKID",
      region: "ap-southeast-1",
      secretAccessKey: "SECRET",
      sessionToken: "TOKEN",
    });
    factory({ maxRetries: 0, timeout: 4000 });

    const callArgs = MockAnthropicBedrock.mock.calls[0]?.[0] as {
      [key: string]: unknown;
    };
    type Credentials = {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
    const resolver = callArgs.providerChainResolver as () => Promise<
      () => Promise<Credentials>
    >;
    const innerFn = await resolver();
    const credentials = await innerFn();
    expect(credentials).toEqual({
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "TOKEN",
    });
  });

  it("omits sessionToken from credentials when not provided", async () => {
    const factory = bedrockClientFactory({
      accessKeyId: "AKID",
      region: "us-west-2",
      secretAccessKey: "SECRET",
    });
    factory({ maxRetries: 0, timeout: 4000 });

    const callArgs = MockAnthropicBedrock.mock.calls[0]?.[0] as {
      [key: string]: unknown;
    };
    type Credentials = {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
    const resolver = callArgs.providerChainResolver as () => Promise<
      () => Promise<Credentials>
    >;
    const innerFn = await resolver();
    const credentials = await innerFn();
    expect(credentials).not.toHaveProperty("sessionToken");
  });
});

describe("vertexClientFactory", () => {
  it("constructs AnthropicVertex with projectId and region (ADC path)", () => {
    const factory = vertexClientFactory({
      project: "my-gcp-project",
      region: "us-central1",
    });
    factory({ maxRetries: 0, timeout: 4000 });

    expect(MockAnthropicVertex).toHaveBeenCalledOnce();
    const callArgs = MockAnthropicVertex.mock.calls[0]?.[0] as {
      [key: string]: unknown;
    };
    expect(callArgs).toMatchObject({
      projectId: "my-gcp-project",
      region: "us-central1",
    });
    expect(callArgs).not.toHaveProperty("googleAuth");
    expect(MockGoogleAuth).not.toHaveBeenCalled();
  });

  it("constructs AnthropicVertex with GoogleAuth when serviceAccountJson provided", () => {
    const serviceAccountJson = JSON.stringify({
      client_email: "sa@project.iam.gserviceaccount.com",
      private_key:
        "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
      type: "service_account",
    });

    const factory = vertexClientFactory({
      project: "my-gcp-project",
      region: "us-east4",
      serviceAccountJson,
    });
    factory({ maxRetries: 0, timeout: 4000 });

    expect(MockAnthropicVertex).toHaveBeenCalledOnce();
    const callArgs = MockAnthropicVertex.mock.calls[0]?.[0] as {
      [key: string]: unknown;
    };
    expect(callArgs).toMatchObject({
      projectId: "my-gcp-project",
      region: "us-east4",
    });
    expect(callArgs).toHaveProperty("googleAuth");

    expect(MockGoogleAuth).toHaveBeenCalledOnce();
    expect(MockGoogleAuth).toHaveBeenCalledWith({
      credentials: {
        client_email: "sa@project.iam.gserviceaccount.com",
        private_key:
          "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
        type: "service_account",
      },
      scopes: "https://www.googleapis.com/auth/cloud-platform",
    });
  });
});

describe("AnthropicFamilyProvider — remaining branches", () => {
  it("returns invalid-output when parsed_output is undefined", async () => {
    const provider = new AnthropicFamilyProvider({
      clientFactory: () => ({
        messages: {
          parse: async () => ({
            parsed_output: undefined,
            stop_reason: "end_turn",
            usage: { output_tokens: 2 },
          }),
        },
      }),
      model: "claude-test",
      secrets: [],
    });

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      { category: "invalid-output", ok: false },
    );
  });

  it("normalizes thrown provider errors and redacts secrets", async () => {
    const error = new Error("Connection failed with key sk-bedrock-secret.");
    const provider = new AnthropicFamilyProvider({
      clientFactory: () => ({
        messages: {
          async parse() {
            throw error;
          },
        },
      }),
      model: "claude-test",
      secrets: ["sk-bedrock-secret"],
    });

    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ category: "provider-error", ok: false });
    const message = result.ok ? "" : result.message;
    expect(message).not.toContain("sk-bedrock-secret");
    expect(message).toContain("[REDACTED]");
  });
});
