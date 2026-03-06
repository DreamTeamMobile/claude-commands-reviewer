import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateGroupingLogic, validateGrouping, generatePrompt } from './grouping-agent.js';
import type { Grouping, CommandInfo } from './types.js';

function makeGrouping(overrides: Partial<Grouping>): Grouping {
  return {
    pattern: 'Bash(test:*)',
    matches: ['Bash(test foo)', 'Bash(test bar)'],
    reasoning: 'test',
    confidence: 'high',
    safetyCategory: 'SAFE_TO_WILDCARD',
    approved: null,
    ...overrides,
  };
}

describe('validateGroupingLogic', () => {
  // --- Subcommand-level groupings should pass ---

  it('should accept Bash(gh pr:*) grouping with gh pr subcommands', () => {
    const g = makeGrouping({
      pattern: 'Bash(gh pr:*)',
      matches: ['Bash(gh pr list)', 'Bash(gh pr view)', 'Bash(gh pr create)', 'Bash(gh pr checkout)'],
    });
    const result = validateGroupingLogic(g);
    assert.equal(result.valid, true, `Expected valid but got: ${result.reason}`);
  });

  it('should accept Bash(gh run:*) grouping with gh run subcommands', () => {
    const g = makeGrouping({
      pattern: 'Bash(gh run:*)',
      matches: ['Bash(gh run list)', 'Bash(gh run view)', 'Bash(gh run watch)'],
    });
    const result = validateGroupingLogic(g);
    assert.equal(result.valid, true, `Expected valid but got: ${result.reason}`);
  });

  it('should accept Bash(git log:*) grouping', () => {
    const g = makeGrouping({
      pattern: 'Bash(git log:*)',
      matches: ['Bash(git log --oneline -5)', 'Bash(git log --all --graph)'],
    });
    const result = validateGroupingLogic(g);
    assert.equal(result.valid, true, `Expected valid but got: ${result.reason}`);
  });

  it('should accept Bash(bd:*) grouping with bd subcommands', () => {
    const g = makeGrouping({
      pattern: 'Bash(bd:*)',
      matches: ['Bash(bd add task)', 'Bash(bd list)', 'Bash(bd update 123)'],
    });
    const result = validateGroupingLogic(g);
    assert.equal(result.valid, true, `Expected valid but got: ${result.reason}`);
  });

  it('should accept Bash(pnpm run:*) grouping', () => {
    const g = makeGrouping({
      pattern: 'Bash(pnpm run:*)',
      matches: ['Bash(pnpm run test)', 'Bash(pnpm run build)', 'Bash(pnpm run lint)'],
    });
    const result = validateGroupingLogic(g);
    assert.equal(result.valid, true, `Expected valid but got: ${result.reason}`);
  });

  // --- Pattern appears in own matches: should auto-fix, not reject ---

  it('should auto-fix pattern appearing in own matches (remove it, keep valid matches)', () => {
    const g = makeGrouping({
      pattern: 'Bash(gh pr:*)',
      matches: ['Bash(gh pr:*)', 'Bash(gh pr list)', 'Bash(gh pr view)'],
    });
    const result = validateGroupingLogic(g);
    assert.equal(result.valid, true, `Expected valid but got: ${result.reason}`);
    assert.ok(!g.matches.includes('Bash(gh pr:*)'), 'Pattern should be removed from matches');
    assert.equal(g.matches.length, 2);
  });

  it('should reject when pattern only matches itself (no concrete commands)', () => {
    const g = makeGrouping({
      pattern: 'Bash(gh pr:*)',
      matches: ['Bash(gh pr:*)'],
    });
    const result = validateGroupingLogic(g);
    assert.equal(result.valid, false);
  });

  // --- Cross-command validation ---

  it('should reject when matches have completely different base command', () => {
    const g = makeGrouping({
      pattern: 'Bash(npm:*)',
      matches: ['Bash(npm install)', 'Bash(yarn add)'],
    });
    const result = validateGroupingLogic(g);
    assert.equal(result.valid, false);
  });

  // --- Safety validation ---

  it('should block rm patterns', () => {
    assert.equal(validateGrouping('Bash(rm:*)'), false);
  });

  it('should block force push patterns', () => {
    assert.equal(validateGrouping('Bash(git push --force:*)'), false);
  });

  it('should allow safe patterns', () => {
    assert.equal(validateGrouping('Bash(gh pr:*)'), true);
    assert.equal(validateGrouping('Bash(pnpm run:*)'), true);
    assert.equal(validateGrouping('Bash(git log:*)'), true);
  });
});

describe('generatePrompt', () => {
  const sampleCommands: CommandInfo[] = [
    { command: 'Bash(gh pr list)', projects: ['/proj1'] },
    { command: 'Bash(gh pr view)', projects: ['/proj1'] },
    { command: 'Bash(gh run list)', projects: ['/proj1', '/proj2'] },
    { command: 'Bash(gh run view)', projects: ['/proj2'] },
  ];

  it('should instruct model to group at subcommand level (e.g., gh pr:* not gh:*)', () => {
    const prompt = generatePrompt(sampleCommands);
    // The prompt should explicitly mention subcommand-level grouping
    assert.ok(
      prompt.includes('gh pr:*') || prompt.includes('subcommand'),
      'Prompt should instruct subcommand-level grouping'
    );
  });

  it('should instruct model to suggest multiple groups for same tool', () => {
    const prompt = generatePrompt(sampleCommands);
    // Should mention creating separate groups like gh pr:* AND gh run:*
    assert.ok(
      prompt.includes('multiple group') || prompt.includes('separate group') || prompt.includes('gh run:*'),
      'Prompt should encourage multiple groups per tool'
    );
  });

  it('should warn against too-broad patterns like Bash(gh:*)', () => {
    const prompt = generatePrompt(sampleCommands);
    assert.ok(
      prompt.includes('too broad') || prompt.includes('Bash(gh:*)') || prompt.includes('overly broad'),
      'Prompt should warn against too-broad patterns'
    );
  });
});
