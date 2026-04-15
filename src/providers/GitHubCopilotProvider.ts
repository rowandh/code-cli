/**
 * @license
 * Copyright 2025 Autohand AI LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotClientOptions } from "@github/copilot-sdk";
import type { LLMProvider } from "./LLMProvider.js";
import type {
  FunctionDefinition,
  GitHubCopilotSettings,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
  ReasoningEffort,
  ToolChoice,
} from "../types.js";

const DEFAULT_MODEL = "claude-sonnet-4.5";
const COMPLETION_TIMEOUT_MS = 120_000;

type FinishReason = LLMResponse["finishReason"];

interface ResponseEnvelope {
  content?: string;
  toolCalls?: LLMToolCall[];
  finishReason?: FinishReason;
}

export class GitHubCopilotProvider implements LLMProvider {
  private readonly clientOptions: CopilotClientOptions;
  private readonly configDir?: string;
  private readonly workingDirectory?: string;
  private model: string;
  private reasoningEffort?: Extract<ReasoningEffort, "low" | "medium" | "high" | "xhigh">;

  constructor(config: GitHubCopilotSettings) {
    this.model = config.model || DEFAULT_MODEL;
    this.reasoningEffort = this.normalizeReasoningEffort(config.reasoningEffort);
    this.configDir = config.configDir;
    this.workingDirectory = config.workingDirectory ?? process.cwd();

    const useLoggedInUser = config.githubToken ? false : config.useLoggedInUser !== false;

    this.clientOptions = {
      cwd: this.workingDirectory,
      githubToken: config.githubToken,
      logLevel: "error",
      useLoggedInUser,
    };
  }

  getName(): string {
    return "github-copilot";
  }

  setModel(model: string): void {
    this.model = model;
  }

  async listModels(): Promise<string[]> {
    return this.withClient(async (client) => {
      const models = await client.listModels();
      return models.map((model) => model.id).filter((id): id is string => Boolean(id));
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.withClient(async (client) => {
        await client.listModels();
      });
      return true;
    } catch {
      return false;
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return this.withClient(async (client) => {
      const session = await client.createSession({
        availableTools: [],
        configDir: this.configDir,
        enableConfigDiscovery: false,
        infiniteSessions: { enabled: false },
        model: request.model || this.model,
        onPermissionRequest: approveAll,
        reasoningEffort: this.reasoningEffort,
        streaming: false,
        workingDirectory: this.workingDirectory,
      });

      try {
        const event = await session.sendAndWait(
          { prompt: this.buildPrompt(request) },
          COMPLETION_TIMEOUT_MS,
        );
        const content = event?.data.content ?? "";
        const parsed = this.parseResponse(content);

        return {
          id: event?.data.messageId ?? "github-copilot-response",
          created: Math.floor(Date.now() / 1000),
          content: parsed.content ?? "",
          toolCalls:
            parsed.toolCalls && parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
          finishReason: parsed.finishReason ?? "stop",
          raw: event ?? content,
        };
      } finally {
        await session.disconnect();
      }
    });
  }

  private normalizeReasoningEffort(
    effort?: ReasoningEffort,
  ): Extract<ReasoningEffort, "low" | "medium" | "high" | "xhigh"> | undefined {
    if (!effort || effort === "none") {
      return undefined;
    }

    return effort;
  }

  private async withClient<T>(run: (client: CopilotClient) => Promise<T>): Promise<T> {
    const client = new CopilotClient(this.clientOptions);
    await client.start();

    try {
      return await run(client);
    } finally {
      await client.stop();
    }
  }

  private buildPrompt(request: LLMRequest): string {
    const payload = {
      messages: request.messages.map((message) => ({
        content: message.content,
        name: message.name,
        role: message.role,
        tool_call_id: message.tool_call_id,
        tool_calls: message.tool_calls,
      })),
      maxTokens: request.maxTokens,
      temperature: request.temperature ?? 0.7,
      toolChoice: this.serializeToolChoice(request.toolChoice),
      tools: this.serializeTools(request.tools),
    };

    return [
      "You are the GitHub Copilot backend for Autohand. Reply with a single JSON object only. No markdown fences, no commentary.",
      "JSON schema: {\"content\": string, \"toolCalls\"?: Array<{\"id\": string, \"type\": \"function\", \"function\": {\"name\": string, \"arguments\": string}}>, \"finishReason\"?: \"stop\" | \"tool_calls\" | \"length\" | \"content_filter\"}.",
      "When requesting a tool, set finishReason to tool_calls and put the tool arguments in function.arguments as a JSON string.",
      JSON.stringify(payload),
    ].join("\n\n");
  }

  private serializeToolChoice(toolChoice?: ToolChoice): ToolChoice | "auto" {
    return toolChoice ?? "auto";
  }

  private serializeTools(tools?: FunctionDefinition[]): FunctionDefinition[] {
    return tools ?? [];
  }

  private parseResponse(content: string): ResponseEnvelope {
    const parsed = this.parseJsonEnvelope(content);
    if (!parsed) {
      return {
        content: content.trim(),
        finishReason: "stop",
      };
    }

    return {
      content: typeof parsed.content === "string" ? parsed.content : "",
      finishReason: this.normalizeFinishReason(parsed.finishReason),
      toolCalls: this.normalizeToolCalls(parsed.toolCalls),
    };
  }

  private parseJsonEnvelope(content: string): Record<string, unknown> | null {
    const trimmed = content.trim();
    const candidates = [trimmed];

    if (trimmed.startsWith("```")) {
      let unwrapped = trimmed;
      if (unwrapped.startsWith("```json")) {
        unwrapped = unwrapped.slice(7).trim();
      } else {
        unwrapped = unwrapped.slice(3).trim();
      }

      if (unwrapped.endsWith("```")) {
        unwrapped = unwrapped.slice(0, -3).trim();
      }

      candidates.push(unwrapped);
    }

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          return parsed;
        }
      } catch {
        // Try the next candidate.
      }
    }

    return null;
  }

  private normalizeFinishReason(value: unknown): FinishReason {
    return value === "tool_calls" || value === "length" || value === "content_filter"
      ? value
      : "stop";
  }

  private normalizeToolCalls(value: unknown): LLMToolCall[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const toolCalls = value.flatMap((toolCall, index) => {
      if (!toolCall || typeof toolCall !== "object") {
        return [];
      }

      const candidate = toolCall as {
        id?: unknown;
        type?: unknown;
        function?: {
          name?: unknown;
          arguments?: unknown;
        };
      };

      if (
        typeof candidate.function?.name !== "string" ||
        typeof candidate.function?.arguments !== "string"
      ) {
        return [];
      }

      return [
        {
          id:
            typeof candidate.id === "string"
              ? candidate.id
              : "tool_call_" + (index + 1),
          type: "function" as const,
          function: {
            name: candidate.function.name,
            arguments: candidate.function.arguments,
          },
        },
      ];
    });

    return toolCalls.length > 0 ? toolCalls : undefined;
  }
}
