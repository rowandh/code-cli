/**
 * @license
 * Copyright 2025 Autohand AI LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi } from 'vitest';
import {
  saveAgentToolMessage,
  type AgentToolOutputRuntimeHost,
} from '../../../src/core/agent/AgentToolOutputRuntime.js';
import type { SessionMessage } from '../../../src/session/types.js';

function makeHost(appended: SessionMessage[]): AgentToolOutputRuntimeHost {
  return {
    sessionManager: {
      getCurrentSession: () => ({
        append: async (message: SessionMessage) => {
          appended.push(message);
        },
        appendTransient: async () => {},
      }),
    },
    toolOutputQueue: Promise.resolve(),
    queueToolMessageChunk: vi.fn(),
  };
}

describe('saveAgentToolMessage', () => {
  it('persists a successful outcome in _meta', async () => {
    const appended: SessionMessage[] = [];
    await saveAgentToolMessage(makeHost(appended), 'read_file', 'contents', 'call-1', {
      success: true,
    });

    expect(appended).toHaveLength(1);
    expect(appended[0]._meta).toEqual({ success: true });
    expect(appended[0].tool_call_id).toBe('call-1');
  });

  it('persists failure kind and exit code in _meta', async () => {
    const appended: SessionMessage[] = [];
    await saveAgentToolMessage(makeHost(appended), 'execute_command', 'boom', 'call-2', {
      success: false,
      kind: 'command',
      exitCode: 127,
    });

    expect(appended[0]._meta).toEqual({ success: false, kind: 'command', exitCode: 127 });
  });

  it('omits _meta when no outcome is provided (legacy shape)', async () => {
    const appended: SessionMessage[] = [];
    await saveAgentToolMessage(makeHost(appended), 'read_file', 'contents', 'call-3');

    expect(appended[0]._meta).toBeUndefined();
  });

  it('omits undefined kind and exitCode keys from _meta', async () => {
    const appended: SessionMessage[] = [];
    await saveAgentToolMessage(makeHost(appended), 'read_file', 'missing', 'call-4', {
      success: false,
      kind: 'operational',
    });

    expect(appended[0]._meta).toEqual({ success: false, kind: 'operational' });
    expect(Object.keys(appended[0]._meta ?? {})).not.toContain('exitCode');
  });
});
