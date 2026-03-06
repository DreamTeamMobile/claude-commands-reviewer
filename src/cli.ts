#!/usr/bin/env tsx

import 'dotenv/config';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { discoverSessions, formatSessionsList, getFilterDate } from './session-discovery.js';
import { aggregateCommands } from './command-aggregator.js';
import { groupCommands } from './grouping-agent.js';
import { readState, writeState, applyReviewFile } from './settings-manager.js';
import { appendToHistory } from './history-tracker.js';
import { interactiveReview } from './interactive-review.js';
import type { ReviewFile } from './types.js';

const REPO_ROOT = process.cwd();
const HISTORY_FILE = join(REPO_ROOT, 'history', 'command-approvals.md');

/**
 * Detect how the CLI was invoked and return the appropriate command prefix.
 * e.g. "npx claude-commands-reviewer", "bunx claude-commands-reviewer",
 *      "pnpm exec claude-commands", "claude-commands", "tsx src/cli.ts"
 */
function getCliName(): string {
  const argv1 = process.argv[1] ?? '';

  // Running via npx/bunx/pnpm — argv[1] is the bin script path
  if (argv1.includes('node_modules/.bin/claude-commands')) {
    // Detect the package manager from npm_execpath or npm_config_user_agent
    const userAgent = process.env.npm_config_user_agent ?? '';
    if (userAgent.startsWith('pnpm')) return 'pnpm exec claude-commands';
    if (userAgent.startsWith('bun')) return 'bunx claude-commands-reviewer';
    if (userAgent.startsWith('yarn')) return 'yarn claude-commands';
    return 'npx claude-commands-reviewer';
  }

  // Running via npx cache (e.g. /Users/.../.npm/_npx/.../claude-commands-reviewer/src/cli.ts)
  if (argv1.includes('_npx') || argv1.includes('npx')) return 'npx claude-commands-reviewer';

  // Running directly as global install
  if (argv1.endsWith('/claude-commands') || argv1.endsWith('\\claude-commands')) return 'claude-commands';

  // Running via tsx/node dev mode
  if (argv1.includes('src/cli.ts')) return 'npx tsx src/cli.ts';

  return 'claude-commands';
}

async function showHelp() {
  const cli = getCliName();
  console.log(`
Claude Commands - Manage multiple Claude Code sessions

USAGE:
  ${cli} <command>

COMMANDS:
  list              List all active Claude Code sessions grouped by project
  collect [--reset] Collect and analyze commands from all projects
                    --reset, -r: Re-scan last 7 days (ignore last run timestamp)
  review <file>     Interactively review and approve/deny commands
  apply <file>      Apply approved commands from review file
  help              Show this help message

EXAMPLES:
  ${cli} list
  ${cli} collect
  ${cli} collect --reset
  ${cli} review review-2025-10-23-183045.json
  ${cli} apply review-2025-10-23-183045.json

REQUIREMENTS:
  Claude Code CLI must be installed and authenticated
`);
}

async function listSessions() {
  console.log('Discovering Claude Code sessions...\n');

  const state = await readState();
  const filterDate = getFilterDate(state.lastCollectRun);

  const projectsMap = await discoverSessions(filterDate);
  const output = formatSessionsList(projectsMap);

  console.log(output);
}

async function collectCommands(reset = false) {
  console.log('Collecting commands from Claude Code sessions...\n');

  // Read state to get filter date
  const state = await readState();

  if (reset) {
    console.log('🔄 Reset flag detected - analyzing all sessions from last 7 days\n');
    state.lastCollectRun = null;
  }

  const filterDate = getFilterDate(state.lastCollectRun);

  console.log(`Analyzing sessions since: ${filterDate.toISOString()}\n`);

  // Discover sessions
  const projectsMap = await discoverSessions(filterDate);
  const projectCount = Object.keys(projectsMap).length;
  const sessionCount = Object.values(projectsMap).reduce((sum, p) => sum + p.sessions.length, 0);

  console.log(`Found ${projectCount} project${projectCount !== 1 ? 's' : ''} with ${sessionCount} active session${sessionCount !== 1 ? 's' : ''}`);

  // Aggregate commands
  const aggregated = await aggregateCommands(projectsMap);
  const totalCommands = aggregated.allowedCommands.length;

  console.log(`Extracted ${totalCommands} unique command${totalCommands !== 1 ? 's' : ''}`);

  if (totalCommands === 0) {
    console.log('\nNo commands found to analyze.');
    return;
  }

  // Group with Opus
  const groupingResult = await groupCommands(aggregated.allowedCommands);

  console.log(`\n✓ Suggested ${groupingResult.groupings.length} command grouping${groupingResult.groupings.length !== 1 ? 's' : ''}`);
  console.log(`✓ Flagged ${groupingResult.ungrouped.length} command${groupingResult.ungrouped.length !== 1 ? 's' : ''} for individual review`);

  // Create review file
  const now = new Date();
  const timestamp = now.toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const reviewFileName = `review-${timestamp}.json`;
  const reviewFilePath = join(REPO_ROOT, reviewFileName);

  const reviewFile: ReviewFile = {
    date: now.toISOString(),
    groupings: groupingResult.groupings,
    ungrouped: groupingResult.ungrouped,
    statistics: {
      totalProjects: projectCount,
      totalCommands: totalCommands,
      grouped: groupingResult.statistics.grouped,
      ungrouped: groupingResult.statistics.ungrouped,
    },
  };

  await writeFile(reviewFilePath, JSON.stringify(reviewFile, null, 2), 'utf-8');

  console.log(`\n✓ Review file created: ${reviewFileName}`);

  // Update state
  state.lastCollectRun = now.toISOString();
  await writeState(state);

  const cli = getCliName();
  console.log(`\nNext steps:`);
  console.log(`1. Review commands interactively: ${cli} review ${reviewFileName}`);
  console.log(`   OR manually edit ${reviewFileName} and set "approved": true/false`);
  console.log(`2. Apply approved commands: ${cli} apply ${reviewFileName}`);
}

async function applyCommands(reviewFileName: string) {
  const reviewFilePath = join(REPO_ROOT, reviewFileName);

  console.log(`Applying approved commands from ${reviewFileName}...\n`);

  // Read review file
  let reviewFile: ReviewFile;
  try {
    const content = await readFile(reviewFilePath, 'utf-8');
    reviewFile = JSON.parse(content);
  } catch (error) {
    console.error(`Error reading review file: ${error}`);
    process.exit(1);
  }

  // Apply to user settings
  const { addedPatterns, addedCommands } = await applyReviewFile(reviewFile);

  const totalApproved = addedPatterns.length + addedCommands.length;

  if (totalApproved === 0) {
    console.log('\nNo new commands to add (all already in settings).');
    console.log('✓ Settings deduped and sorted.');
    return;
  }

  console.log(`\n✓ Added ${addedPatterns.length} pattern${addedPatterns.length !== 1 ? 's' : ''}`);
  console.log(`✓ Added ${addedCommands.length} individual command${addedCommands.length !== 1 ? 's' : ''}`);

  // Append to history
  await appendToHistory(HISTORY_FILE, reviewFile, addedPatterns, addedCommands);

  console.log(`\n✓ All approved commands have been added to ~/.claude/settings.json`);
  console.log(`✓ New Claude Code sessions will automatically allow these commands`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    await showHelp();
    return;
  }

  switch (command) {
    case 'list':
      await listSessions();
      break;

    case 'collect':
      const hasReset = args[1] === '--reset' || args[1] === '-r';
      await collectCommands(hasReset);
      break;

    case 'review':
      const reviewFileToReview = args[1];
      if (!reviewFileToReview) {
        console.error('Error: Please provide a review file path');
        console.error(`Usage: ${getCliName()} review <review-file>`);
        process.exit(1);
      }
      await interactiveReview(join(REPO_ROOT, reviewFileToReview), getCliName());
      break;

    case 'apply':
      const reviewFile = args[1];
      if (!reviewFile) {
        console.error('Error: Please provide a review file path');
        console.error(`Usage: ${getCliName()} apply <review-file>`);
        process.exit(1);
      }
      await applyCommands(reviewFile);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error(`Run "${getCliName()} help" for usage information`);
      process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
