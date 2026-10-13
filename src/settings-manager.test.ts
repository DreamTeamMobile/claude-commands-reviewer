import { describe, it, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ReviewFile } from './types.js';

// settings-manager resolves ~/.claude at import time, so point HOME at a
// scratch directory before loading it.
const fakeHome = mkdtempSync(join(tmpdir(), 'claude-commands-settings-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

const { readUserSettings, applyReviewFile } = await import('./settings-manager.js');

const claudeDir = join(fakeHome, '.claude');
const settingsFile = join(claudeDir, 'settings.json');

function makeReviewFile(): ReviewFile {
  return {
    date: '2026-01-01T00:00:00.000Z',
    groupings: [
      {
        pattern: 'Bash(git log:*)',
        matches: ['Bash(git log -1)', 'Bash(git log --oneline)'],
        reasoning: 'read-only',
        confidence: 'high',
        safetyCategory: 'SAFE_TO_WILDCARD',
        approved: true,
      },
    ],
    ungrouped: [],
    statistics: { totalProjects: 1, totalCommands: 2, grouped: 2, ungrouped: 0 },
  };
}

describe('settings-manager', () => {
  beforeEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
    mkdirSync(claudeDir, { recursive: true });
    // Keep the module's progress output out of the test runner's stream
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
  });

  afterEach(() => {
    mock.restoreAll();
  });

  after(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('should throw instead of returning empty settings when settings.json is malformed', async () => {
    writeFileSync(settingsFile, '{ "model": "opus", }');
    await assert.rejects(readUserSettings(), /settings\.json/);
  });

  it('should throw when settings.json is not a JSON object', async () => {
    writeFileSync(settingsFile, 'null');
    await assert.rejects(readUserSettings(), /expected a JSON object/);
  });

  it('should leave a malformed settings.json untouched when applying a review', async () => {
    const original = '{\n  "model": "opus",\n  "hooks": { "PreToolUse": [] },\n  "permissions": { "allow": ["Bash(ls:*)"] },\n}\n';
    writeFileSync(settingsFile, original);

    await assert.rejects(applyReviewFile(makeReviewFile()));

    assert.equal(readFileSync(settingsFile, 'utf-8'), original);
  });

  it('should keep existing settings and permissions when applying to a valid settings.json', async () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({ model: 'opus', env: { FOO: 'bar' }, permissions: { allow: ['Bash(ls:*)'], deny: [] } })
    );

    const { addedPatterns } = await applyReviewFile(makeReviewFile());

    assert.deepEqual(addedPatterns, ['Bash(git log:*)']);
    const written = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    assert.equal(written.model, 'opus');
    assert.deepEqual(written.env, { FOO: 'bar' });
    assert.deepEqual(written.permissions.allow, ['Bash(git log:*)', 'Bash(ls:*)']);
  });

  it('should create settings.json when it does not exist', async () => {
    assert.equal(existsSync(settingsFile), false);

    const { addedPatterns } = await applyReviewFile(makeReviewFile());

    assert.deepEqual(addedPatterns, ['Bash(git log:*)']);
    const written = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    assert.deepEqual(written.permissions.allow, ['Bash(git log:*)']);
  });
});
