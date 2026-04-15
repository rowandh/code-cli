/**
 * @license
 * Copyright 2025 Autohand AI LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockApproveAll,
  mockClientConstructor,
  mockCreateSession,
  mockDisconnect,
  mockListModels,
  mockSendAndWait,
  mockStart,
  mockStop,
} = vi.hoisted(() => ({
  mockApproveAll: vi.fn(() => ({ outcome: "allow" })),
  mockClientConstructor: vi.fn(),
  mockCreateSession: vi.fn(),
  mockDisconnect: vi.fn(),
  mockListModels: vi.fn(),
  mockSendAndWait: vi.fn(),
  mockStart: vi.fn(),
  mockStop: vi.fn(),
}));

vi.mock("@github/copilot-sdk", () => ({
  approveAll: mockApproveAll,
  CopilotClient: mockClientConstructor.mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    listModels: mockListModels,
    createSession: mockCreateSession,
  })),
}));

import { GitHubCopilotProvider } from "../../src/providers/GitHubCopilotProvider.js";

describe("GitHubCopilotProvider", () => {
  beforeEach(() => {
    mockStart.mockResolvedValue(undefined);
    mockStop.mockResolvedValue([]);
    mockDisconnect.mockResolvedValue(undefined);
    mockCreateSession.mockResolvedValue({
      sendAndWait: mockSendAndWait,
      disconnect: mockDisconnect,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists models from the Copilot SDK", async () => {
    mockListModels.mockResolvedValue([
      { id: "gpt-5", name: "GPT-5" },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    ]);

    const provider = new GitHubCopilotProvider({
      model: "gpt-5",
      githubToken: "ghu_test_token",
    });

    await expect(provider.listModels()).resolves.toEqual([
      "gpt-5",
      "claude-sonnet-4.5",
    ]);

    expect(mockClientConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        githubToken: "ghu_test_token",
        useLoggedInUser: false,
      }),
    );
  });

  it("passes through Autohand structured JSON and adapts tool calls", async () => {
    mockSendAndWait.mockResolvedValue({
      data: {
        content: JSON.stringify({
          thought: "Need to write the file.",
          toolCalls: [
            {
              tool: "write_file",
              args: { path: "src/test.ts", content: "hello" },
            },
          ],
        }),
      },
    });

    const provider = new GitHubCopilotProvider({
      model: "claude-sonnet-4.5",
    });

    const response = await provider.complete({
      messages: [{ role: "user", content: "Create the file." }],
      tools: [
        {
          name: "write_file",
          description: "Write a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
          },
        },
      ],
    });

    expect(response.content).toBe(
      JSON.stringify({
        thought: "Need to write the file.",
        toolCalls: [
          {
            tool: "write_file",
            args: { path: "src/test.ts", content: "hello" },
          },
        ],
      }),
    );
    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      {
        id: "tool_call_1",
        type: "function",
        function: {
          name: "write_file",
          arguments: JSON.stringify({ path: "src/test.ts", content: "hello" }),
        },
      },
    ]);
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4.5",
        availableTools: [],
        onPermissionRequest: expect.any(Function),
      }),
    );
    expect(mockDisconnect).toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalled();
  });

  it("passes through Autohand structured final responses", async () => {
    mockSendAndWait.mockResolvedValue({
      data: {
        content: JSON.stringify({
          thought: "Done.",
          finalResponse: "All set.",
          toolCalls: [],
        }),
      },
    });

    const provider = new GitHubCopilotProvider({
      model: "gpt-5",
    });

    const response = await provider.complete({
      messages: [{ role: "user", content: "Say hi" }],
    });

    expect(JSON.parse(response.content)).toEqual({
      thought: "Done.",
      finalResponse: "All set.",
      toolCalls: [],
    });
    expect(response.toolCalls).toBeUndefined();
    expect(response.finishReason).toBe("stop");
  });

  it("falls back to plain text when the assistant response is not valid JSON", async () => {
    mockSendAndWait.mockResolvedValue({
      data: { content: "Plain text response" },
    });

    const provider = new GitHubCopilotProvider({
      model: "gpt-5",
    });

    const response = await provider.complete({
      messages: [{ role: "user", content: "Say hi" }],
    });

    expect(response.content).toBe("Plain text response");
    expect(response.toolCalls).toBeUndefined();
    expect(response.finishReason).toBe("stop");
  });

  it("reports unavailable when model listing fails", async () => {
    mockListModels.mockRejectedValue(new Error("boom"));

    const provider = new GitHubCopilotProvider({
      model: "gpt-5",
    });

    await expect(provider.isAvailable()).resolves.toBe(false);
  });
});
