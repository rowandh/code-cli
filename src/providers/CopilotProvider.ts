/**
 * @license
 * Copyright 2025 Autohand AI LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { LLMGatewayClient } from './LLMGatewayClient.js';
import type { LLMProvider } from './LLMProvider.js';
import type {
  CopilotSettings,
  LLMRequest,
  LLMResponse,
  NetworkSettings,
} from '../types.js';

export const COPILOT_DEFAULT_BASE_URL = 'http://localhost:4141/v1';

export class CopilotProvider implements LLMProvider {
  private client: LLMGatewayClient;
  private model: string;

  constructor(config: CopilotSettings, networkSettings?: NetworkSettings) {
    const effectiveConfig = {
      ...config,
      baseUrl: config.baseUrl ?? COPILOT_DEFAULT_BASE_URL,
    };
    this.client = new LLMGatewayClient(effectiveConfig, networkSettings);
    this.model = effectiveConfig.model;
  }

  getName(): string {
    return 'copilot';
  }

  setModel(model: string): void {
    this.model = model;
    this.client.setDefaultModel(model);
  }

  async listModels(): Promise<string[]> {
    return [this.model];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return this.client.complete(request);
  }
}
