#!/usr/bin/env tsx

import { readFile, writeFile, copyFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { OrchestratorState, ProjectSettings, ReviewFile } from './types.js';

const CLAUDE_DIR = join(homedir(), '.claude');
const USER_SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');
const STATE_FILE = join(CLAUDE_DIR, 'orchestrator-state.json');

/**
 * Read orchestrator state (last run timestamp)
 */
export async function readState(): Promise<OrchestratorState> {
  if (!existsSync(STATE_FILE)) {
    return { lastCollectRun: null };
  }

  try {
    const content = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error reading state file:', error);
    return { lastCollectRun: null };
  }
}

/**
 * Write orchestrator state
 */
export async function writeState(state: OrchestratorState): Promise<void> {
  try {
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error writing state file:', error);
    throw error;
  }
}

/**
 * Read user settings from ~/.claude/settings.json
 */
export async function readUserSettings(): Promise<ProjectSettings> {
  if (!existsSync(USER_SETTINGS_FILE)) {
    return { permissions: { allow: [], deny: [], ask: [] } };
  }

  try {
    const content = await readFile(USER_SETTINGS_FILE, 'utf-8');
    const settings = JSON.parse(content);

    // Ensure permissions structure exists
    if (!settings.permissions) {
      settings.permissions = { allow: [], deny: [], ask: [] };
    }
    if (!settings.permissions.allow) {
      settings.permissions.allow = [];
    }

    return settings;
  } catch (error) {
    console.error('Error reading user settings:', error);
    return { permissions: { allow: [], deny: [], ask: [] } };
  }
}

/**
 * Write user settings to ~/.claude/settings.json with backup
 */
export async function writeUserSettings(settings: ProjectSettings): Promise<void> {
  try {
    // Create backup
    if (existsSync(USER_SETTINGS_FILE)) {
      const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
      const backupFile = `${USER_SETTINGS_FILE}.backup.${timestamp}`;
      await copyFile(USER_SETTINGS_FILE, backupFile);
      console.log(`✓ Backup created: ${backupFile}`);
    }

    // Dedupe and sort permission lists before writing
    if (settings.permissions) {
      for (const key of ['allow', 'deny', 'ask'] as const) {
        const list = settings.permissions[key];
        if (Array.isArray(list)) {
          settings.permissions[key] = [...new Set(list)].sort();
        }
      }
    }

    // Write new settings
    await writeFile(USER_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    console.log(`✓ Updated: ${USER_SETTINGS_FILE}`);
  } catch (error) {
    console.error('Error writing user settings:', error);
    throw error;
  }
}

/**
 * Apply approved commands from review file to user settings
 */
export async function applyReviewFile(reviewFile: ReviewFile): Promise<{
  addedPatterns: string[];
  addedCommands: string[];
}> {
  const userSettings = await readUserSettings();
  const existingAllowed = new Set(userSettings.permissions?.allow || []);

  const addedPatterns: string[] = [];
  const addedCommands: string[] = [];

  // Add approved groupings
  for (const grouping of reviewFile.groupings) {
    if (grouping.approved === true) {
      // Handle MCP server groupings with choice
      if (grouping.groupType === 'mcp-server') {
        if (grouping.mcpChoice === 'server') {
          // User chose to approve entire server
          if (!existingAllowed.has(grouping.pattern)) {
            userSettings.permissions!.allow!.push(grouping.pattern);
            addedPatterns.push(grouping.pattern);
          }
        } else if (grouping.mcpChoice === 'individual') {
          // User chose to approve individual commands
          for (const command of grouping.matches) {
            if (!existingAllowed.has(command)) {
              userSettings.permissions!.allow!.push(command);
              addedCommands.push(command);
            }
          }
        }
        // If mcpChoice is undefined, skip (not properly reviewed)
      } else {
        // Standard grouping (non-MCP)
        if (!existingAllowed.has(grouping.pattern)) {
          userSettings.permissions!.allow!.push(grouping.pattern);
          addedPatterns.push(grouping.pattern);
        }
      }
    }
  }

  // Add approved ungrouped commands
  for (const ungrouped of reviewFile.ungrouped) {
    if (ungrouped.approved === true) {
      if (!existingAllowed.has(ungrouped.command)) {
        userSettings.permissions!.allow!.push(ungrouped.command);
        addedCommands.push(ungrouped.command);
      }
    }
  }

  // Write updated settings
  await writeUserSettings(userSettings);

  return { addedPatterns, addedCommands };
}
