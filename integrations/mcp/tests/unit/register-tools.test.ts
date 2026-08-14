import { describe, expect, test } from 'bun:test';
import type { ResolvedConfig } from '../../src/lib/config.ts';
import type { GlmClient } from '../../src/lib/glm-client.ts';
import { type ToolRegistrar, registerTools } from '../../src/tools/index.ts';

const CONFIG: ResolvedConfig = {
  port: 3300,
  workspace: 'demo',
  token: 'tok',
  baseUrl: 'http://localhost:3300',
};

interface Registered {
  name: string;
  config: { title?: string; description?: string; inputSchema?: Record<string, unknown> };
}

function fakeServer(into: Registered[]): ToolRegistrar {
  return {
    registerTool: (name: string, config: Registered['config']) => {
      into.push({ name, config });
    },
  };
}

describe('registerTools', () => {
  const registered: Registered[] = [];
  registerTools(fakeServer(registered), { client: {} as GlmClient, config: CONFIG });
  const names = registered.map((r) => r.name);

  test('registers the full tool surface', () => {
    expect(names).toEqual([
      'glm_status',
      'glm_list_components',
      'glm_get_node',
      'glm_get_component_spec',
      'glm_verify',
      'glm_run_acceptance_verifier',
      'glm_record_generation',
      'glm_apply_patch',
      'glm_create_workspace',
      'glm_create_node',
      'glm_update_node',
      'glm_delete_node',
    ]);
  });

  test('an authoring session can create, revise and remove a node', () => {
    // Without all three the surface is a trap: a structural mistake made by
    // glm_create_node cannot be undone, because glm_apply_patch edits only the
    // body and the glm_id is already taken.
    for (const required of ['glm_create_node', 'glm_update_node', 'glm_delete_node']) {
      expect(names).toContain(required);
    }
  });

  test('every tool carries a title, description and input schema', () => {
    for (const { name, config } of registered) {
      expect(config.title, `${name} title`).toBeTruthy();
      expect(config.description, `${name} description`).toBeTruthy();
      expect(config.inputSchema, `${name} inputSchema`).toBeDefined();
    }
  });

  test('the mutating tools accept an optional workspace override', () => {
    for (const name of ['glm_create_node', 'glm_update_node', 'glm_delete_node']) {
      const tool = registered.find((r) => r.name === name);
      expect(Object.keys(tool?.config.inputSchema ?? {}), name).toContain('workspace');
    }
  });
});
