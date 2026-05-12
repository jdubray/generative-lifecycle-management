import { describe, expect, test } from 'bun:test';
import { classifyIntent } from '../../../src/agent/intent.ts';

describe('classifyIntent', () => {
  test('archive keywords route to the archive scenario', () => {
    expect(classifyIntent('add a way to archive todos').scenario).toBe('archive');
    expect(classifyIntent('I want delete to soft-delete').scenario).toBe('archive');
  });

  test('multi-user / team / postgres routes to the multi scenario', () => {
    expect(classifyIntent('spin up a team variant').scenario).toBe('multi');
    expect(classifyIntent('multi-user with postgres').scenario).toBe('multi');
  });

  test('drift / hand-edit routes to the drift scenario', () => {
    expect(classifyIntent('reconcile the drift on todo_rest_api').scenario).toBe('drift');
    expect(classifyIntent('there was a hand-edit on todos.ts').scenario).toBe('drift');
  });

  test('promote / library routes to the promote scenario', () => {
    expect(classifyIntent('promote the filter engine to a shared library').scenario).toBe('promote');
  });

  test('non-matching messages return null', () => {
    const r = classifyIntent('hello world');
    expect(r.scenario).toBeNull();
    expect(r.reason).toContain('no scripted scenario');
  });

  test('empty message returns null with an "empty" reason', () => {
    expect(classifyIntent('').scenario).toBeNull();
    expect(classifyIntent('   ').scenario).toBeNull();
  });
});
