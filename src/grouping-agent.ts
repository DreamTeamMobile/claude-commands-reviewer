#!/usr/bin/env tsx

import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { CommandInfo, GroupingResult, Grouping } from './types.js';

const NEVER_WILDCARD_PATTERNS = [
  /^rm(\s|$)/,
  /^del(\s|$)/,
  /--force/,
  /--hard/,
  /chmod/,
  /chown/,
  /sudo/,
  /curl/,
  /wget/,
  /systemctl/,
  /kubectl.*delete/,
  /terraform.*destroy/,
];

/**
 * Validate MCP-specific patterns
 */
function validateMCPGrouping(pattern: string): { valid: boolean; reason?: string } {
  // Only validate MCP patterns
  if (!pattern.startsWith('mcp__')) {
    return { valid: true };
  }

  // Check 1: MCP patterns must not have wildcards
  if (pattern.includes('*')) {
    return {
      valid: false,
      reason: 'MCP patterns cannot use wildcards. Use exact pattern like "mcp__servername"'
    };
  }

  // Check 2: Block mcp__* (too broad)
  if (pattern === 'mcp__*' || pattern === 'mcp__:*') {
    return {
      valid: false,
      reason: 'mcp__* is too broad - must specify server name'
    };
  }

  // Check 3: Validate MCP pattern format
  // Valid formats: mcp__servername OR mcp__servername__commandname
  const mcpServerPattern = /^mcp__[a-zA-Z0-9-_]+$/;
  const mcpCommandPattern = /^mcp__[a-zA-Z0-9-_]+__[a-zA-Z0-9-_]+$/;

  if (!mcpServerPattern.test(pattern) && !mcpCommandPattern.test(pattern)) {
    return {
      valid: false,
      reason: `Invalid MCP pattern format. Expected "mcp__servername" or "mcp__servername__commandname", got "${pattern}"`
    };
  }

  return { valid: true };
}

/**
 * Validate that a grouping pattern is safe
 */
export function validateGrouping(pattern: string): boolean {
  // Validate MCP patterns
  const mcpValidation = validateMCPGrouping(pattern);
  if (!mcpValidation.valid) {
    console.warn(`⚠️  BLOCKED: ${mcpValidation.reason}`);
    return false;
  }

  // Extract the actual command from pattern like "Bash(rm:*)"
  const commandMatch = pattern.match(/Bash\(([^:)]+)/);
  if (!commandMatch) return true;

  const command = commandMatch[1];

  // Check against never-wildcard list
  for (const dangerous of NEVER_WILDCARD_PATTERNS) {
    if (dangerous.test(command)) {
      console.warn(`⚠️  BLOCKED: Refusing to wildcard dangerous pattern: ${pattern}`);
      return false;
    }
  }

  return true;
}

/**
 * Validate that a grouping makes logical sense
 */
export function validateGroupingLogic(grouping: Grouping): { valid: boolean; reason?: string } {
  // Check 1: Pattern shouldn't appear in its own matches — auto-fix by removing it
  if (grouping.matches.includes(grouping.pattern)) {
    grouping.matches = grouping.matches.filter(m => m !== grouping.pattern);
    if (grouping.matches.length === 0) {
      return {
        valid: false,
        reason: `Pattern "${grouping.pattern}" only matched itself - no concrete commands to group`
      };
    }
  }

  // Check 1b: WebFetch patterns can't use wildcards in domain names
  if (grouping.pattern.startsWith('WebFetch(domain:') && grouping.pattern.includes('*')) {
    return {
      valid: false,
      reason: `WebFetch doesn't support domain wildcards. Pattern "${grouping.pattern}" is invalid - domains must be explicit`
    };
  }

  // Check 1c: MCP server groupings must have matches from same server
  if (grouping.pattern.startsWith('mcp__') && grouping.groupType === 'mcp-server') {
    const serverPattern = /^mcp__([a-zA-Z0-9-_]+)$/;
    const serverMatch = grouping.pattern.match(serverPattern);

    if (serverMatch) {
      const serverName = serverMatch[1];
      const expectedPrefix = `mcp__${serverName}__`;

      for (const match of grouping.matches) {
        if (!match.startsWith(expectedPrefix)) {
          return {
            valid: false,
            reason: `MCP grouping for server "${serverName}" contains command from different server: "${match}"`
          };
        }
      }
    }
  }

  // Check 2: For Bash commands, all matches must start with the same command base
  if (grouping.pattern.startsWith('Bash(') && grouping.pattern.includes(':*')) {
    const patternBase = grouping.pattern.split(':*')[0]; // e.g., "Bash(pnpm run"

    for (const match of grouping.matches) {
      // Each match must start with the exact pattern base
      if (!match.startsWith(patternBase)) {
        return {
          valid: false,
          reason: `Match "${match}" doesn't start with pattern base "${patternBase}"`
        };
      }
    }

    // Check that all matches start with the base command from the pattern
    // e.g., pattern "Bash(pnpm:*)" → base "pnpm", so "pnpm install", "pnpm build" are all valid
    const patternCmd = grouping.pattern.match(/Bash\(([^:)]+)/)?.[1]?.trim(); // e.g., "pnpm" or "pnpm run"
    if (patternCmd) {
      const invalidMatches: string[] = [];
      for (const match of grouping.matches) {
        const matchCmd = match.match(/Bash\(([^:)]+)/)?.[1]?.trim();
        if (matchCmd && !matchCmd.startsWith(patternCmd)) {
          invalidMatches.push(matchCmd);
        }
      }
      if (invalidMatches.length > 0) {
        return {
          valid: false,
          reason: `Pattern base "${patternCmd}" but some matches don't match: ${invalidMatches.join(', ')}`
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Generate the prompt for command grouping
 */
export function generatePrompt(commands: CommandInfo[]): string {
  const commandsList = commands
    .map(c => `- ${c.command} (used in ${c.projects.length} project${c.projects.length > 1 ? 's' : ''})`)
    .join('\n');

  return `You are an expert at analyzing command patterns for safety and efficiency in developer workflows.

TASK: Analyze these Claude Code permission commands and suggest intelligent groupings.

COMMANDS:
${commandsList}

SAFETY FRAMEWORK:

1. **SAFE TO WILDCARD** (Confidence: HIGH):
   - Development tool commands: poetry run, npm run, pnpm, yarn
   - Version control (non-destructive): git checkout, git add, git status, git diff, git log
   - Testing frameworks: pytest, jest, vitest, cargo test
   - Build tools: npm build, cargo build, make
   - Linters/formatters: eslint, prettier, black, rustfmt
   - Package managers (read): pip list, npm list, cargo tree

   Pattern: Commands that are project-scoped, reversible, or read-only

2. **MAYBE SAFE** (Confidence: MEDIUM - suggest but flag for review):
   - Version control (publishing): git commit, git push (without --force)
   - Package installation: npm install, pip install, poetry add
   - Database migrations: forward migrations only

   Pattern: Commands that modify state but are generally safe in development

3. **NEVER WILDCARD** (Confidence: HIGH - keep individual):
   - Destructive file operations: rm, rmdir, del, unlink
   - Force operations: git push --force, git reset --hard
   - Permission changes: chmod, chown, sudo
   - Network operations: curl, wget (can download arbitrary code)
   - System modifications: systemctl, service, kill
   - Production deployments: kubectl apply, terraform apply, aws s3 rm
   - Domain access: WebFetch(domain:*) - keep specific domains
   - Sensitive paths: Read(//home/**), Read(//etc/**), paths with credentials

   Pattern: Irreversible, security-sensitive, or production-affecting commands

4. **MCP COMMANDS** (Model Context Protocol):

   MCP commands follow the pattern: mcp__servername__commandname

   **Grouping Rules**:
   - Pattern format: "mcp__servername" (NO wildcard suffix like :* or *)
   - Example: "mcp__playwright" allows ALL commands from playwright server
   - Safety: Generally safe (MCP_SERVER category) - MCP servers are installed by user

   **CRITICAL - NO WILDCARDS**:
   - ❌ WRONG: "mcp__playwright:*" - wildcards not supported
   - ❌ WRONG: "mcp__playwright__*" - wildcards not supported
   - ❌ WRONG: "mcp__*" - too broad, must specify server
   - ✅ CORRECT: "mcp__playwright" - allows all playwright commands
   - ✅ CORRECT: "mcp__playwright__navigate" - specific command

   **Two Grouping Options**:
   When you find multiple MCP commands from same server, create a grouping with:
   - pattern: "mcp__servername" (e.g., "mcp__playwright")
   - matches: All commands from that server
   - groupType: "mcp-server"
   - safetyCategory: "MCP_SERVER"
   - User will choose: approve entire server OR approve individual commands

   **Examples**:
   Input commands:
   - mcp__playwright__navigate
   - mcp__playwright__click
   - mcp__playwright__screenshot

   Output grouping:
   {
     "pattern": "mcp__playwright",
     "matches": ["mcp__playwright__navigate", "mcp__playwright__click", "mcp__playwright__screenshot"],
     "reasoning": "MCP Server: playwright (3 commands). User can approve entire server or individual commands.",
     "confidence": "high",
     "safetyCategory": "MCP_SERVER",
     "groupType": "mcp-server"
   }

5. **WILDCARDING RULES** (from official Claude Code IAM docs):

   **Bash Commands**:
   - Wildcards ONLY work with :* suffix (must follow a colon)
   - The :* matches everything that starts with the prefix
   - Examples:
     - ✅ CORRECT: "Bash(npm run:*)" matches "npm run test", "npm run build", "npm run lint"
     - ✅ CORRECT: "Bash(poetry run:*)" matches "poetry run test", "poetry run lint"
     - ✅ CORRECT: "Bash(pnpm run:*)" matches all pnpm run commands
     - ❌ WRONG: "Bash(npm run *)" - wildcard must follow colon, not space
     - ❌ WRONG: "Bash(npm *)" - too broad, includes npm install, npm test, etc.
     - ❌ DANGEROUS: "Bash(rm:*)" - matches all rm commands including "rm -rf /"

   - ⚠️ CRITICAL: Each base command must be separate:
     - "Bash(pnpm run:*)" ≠ "Bash(pnpm test:*)" - different subcommands
     - "Bash(pnpm run:*)" ≠ "Bash(pnpm build:*)" - different subcommands
     - "Bash(bun:*)" ≠ "Bash(bunx:*)" - different executables
     - "Bash(npm:*)" ≠ "Bash(npx:*)" - different executables

   - Pattern matching rules:
     - Pattern "Bash(npm run:*)" can ONLY match commands starting with "npm run"
     - If you have "npm test", "npm build", "npm run test" - they need SEPARATE patterns:
       - "Bash(npm test:*)" for npm test commands
       - "Bash(npm build:*)" for npm build commands
       - "Bash(npm run:*)" for npm run commands

   **WebFetch**:
   - NO wildcards supported at all (per official docs)
   - Each domain must be listed separately
   - Examples:
     - ✅ CORRECT: "WebFetch(domain:github.com)" - single domain
     - ✅ CORRECT: "WebFetch(domain:stackoverflow.com)" - another separate entry
     - ❌ WRONG: "WebFetch(domain:*)" - wildcards not supported
     - ❌ WRONG: "WebFetch(domain:docs.*)" - wildcards not supported
     - ❌ WRONG: Any attempt to group multiple domains
   - Note: A single domain like "WebFetch(domain:github.com)" already includes subdomains

   **Read/Write/Edit**:
   - Use gitignore-style patterns
   - Be conservative with wildcards
   - Examples:
     - ✅ CORRECT: "Read(//Users/alex/work/**)" - specific path prefix
     - ❌ DANGEROUS: "Read(//**)" - entire filesystem

6. **GROUPING LOGIC**:

   **Group at SUBCOMMAND level (2nd argument), not tool level**:
   - The wildcard :* should replace the ARGUMENTS, not the subcommand
   - Create SEPARATE groups for each subcommand of the same tool
   - Example: "gh pr list", "gh pr view", "gh pr create" → "Bash(gh pr:*)"
   - Example: "gh run list", "gh run view" → "Bash(gh run:*)"
   - Example: "git log --oneline", "git log --all" → "Bash(git log:*)"
   - Example: "git diff HEAD", "git diff --cached" → "Bash(git diff:*)"

   **Create MULTIPLE separate groups when a tool has different subcommands**:
   - If you see "gh pr list", "gh pr view", "gh run list", "gh run view"
     → Create TWO groups: "Bash(gh pr:*)" AND "Bash(gh run:*)"
   - If you see "git log --oneline", "git diff HEAD", "git status"
     → Create separate groups: "Bash(git log:*)", "Bash(git diff:*)", "Bash(git status:*)"
   - Do NOT collapse these into a single overly broad pattern like "Bash(gh:*)" or "Bash(git:*)"

   **Can be grouped if**:
   - ALL commands have the EXACT same prefix before :*
   - Example: "Bash(npm run test)", "Bash(npm run build)", "Bash(npm run lint)" → "Bash(npm run:*)"
   - All variations are in SAFE category
   - MCP commands from same server → "mcp__servername" (user chooses server-level or individual)

   **MUST stay separate if**:
   - Different executables (npm vs npx vs pnpm)
   - Different subcommands (pnpm run vs pnpm test vs pnpm build)
   - Any command is destructive
   - WebFetch domains - NEVER group (no wildcard support)
   - Pattern would be too broad (e.g., "Bash(gh:*)" instead of "Bash(gh pr:*)")

7. **CRITICAL VALIDATION CHECKS**:
   - ❌ NEVER include the pattern itself in the matches array
   - ❌ NEVER group commands with different prefixes (before :*)
   - ❌ NEVER use wildcards in WebFetch
   - ❌ NEVER use wildcards in MCP patterns (not :*, not *, just "mcp__servername")
   - ❌ NEVER use mcp__* (too broad)
   - ✅ ALL matches must start with the same prefix as the pattern
   - ✅ For MCP groupings, all matches must be from the same server

OUTPUT FORMAT (strict JSON):
{
  "groupings": [
    {
      "pattern": "Bash(npm run:*)",
      "matches": ["Bash(npm run test)", "Bash(npm run build)", "Bash(npm run lint)"],
      "reasoning": "Safe: All npm run commands execute package.json scripts. Pattern 'npm run:*' correctly matches all commands starting with 'npm run'.",
      "confidence": "high",
      "safetyCategory": "SAFE_TO_WILDCARD"
    },
    {
      "pattern": "mcp__playwright",
      "matches": ["mcp__playwright__navigate", "mcp__playwright__click", "mcp__playwright__screenshot"],
      "reasoning": "MCP Server: playwright (3 commands). User can approve entire server or individual commands.",
      "confidence": "high",
      "safetyCategory": "MCP_SERVER",
      "groupType": "mcp-server"
    }
  ],
  "ungrouped": [
    {
      "command": "Bash(npm test)",
      "reasoning": "Cannot group with 'npm run' commands - different subcommand. Keep separate.",
      "shouldApprove": true,
      "safetyCategory": "SAFE_TO_WILDCARD"
    },
    {
      "command": "WebFetch(domain:docs.stripe.com)",
      "reasoning": "WebFetch does not support wildcards. Each domain must be separate.",
      "shouldApprove": true,
      "safetyCategory": "SAFE_TO_WILDCARD"
    },
    {
      "command": "Bash(rm -rf temp)",
      "reasoning": "Dangerous: Destructive file deletion. Never wildcard rm commands.",
      "shouldApprove": false,
      "safetyCategory": "NEVER_WILDCARD"
    }
  ],
  "statistics": {
    "totalCommands": ${commands.length},
    "grouped": 0,
    "ungrouped": 0,
    "categoryCounts": {
      "SAFE_TO_WILDCARD": 0,
      "MAYBE_SAFE": 0,
      "NEVER_WILDCARD": 0
    }
  }
}

Be conservative. When in doubt, don't group. User safety is paramount.

CRITICAL OUTPUT RULES:
- Return ONLY valid JSON — no markdown, no code blocks, no commentary, no text before or after
- Keep "reasoning" strings to 10 words or fewer
- NEVER split the response into multiple parts or ask to continue
- Return ALL groupings AND ALL ungrouped items in ONE single JSON object
- If there are many ungrouped commands, still include them all — do not truncate or offer to continue
- The entire response must be parseable as a single JSON.parse() call`;
}

/**
 * Call Claude CLI using spawn
 */
async function callClaudeCLI(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Get claude path from env or use default locations
    const claudePaths = [
      process.env.CLAUDE_CLI_PATH,
      join(homedir(), '.claude', 'local', 'claude'),
      join(homedir(), '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      'claude', // fallback to PATH
    ].filter(Boolean) as string[];

    let claudePath: string | null = null;
    for (const p of claudePaths) {
      if (existsSync(p)) {
        claudePath = p;
        break;
      }
    }

    // If no absolute path found, try resolving 'claude' via which/where
    if (!claudePath) {
      try {
        const whichCmd = process.platform === 'win32' ? 'where' : 'which';
        const result = spawnSync(whichCmd, ['claude'], { encoding: 'utf-8' });
        const resolved = result.stdout?.trim();
        if (resolved && existsSync(resolved)) {
          claudePath = resolved;
        }
      } catch {
        // which/where failed
      }
    }

    if (!claudePath) {
      reject(new Error('Claude CLI not found. Please set CLAUDE_CLI_PATH in .env file or ensure claude is in PATH'));
      return;
    }

    // Clear CLAUDECODE env var to allow spawning claude from within a Claude Code session
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const claude = spawn(claudePath, ['--model', 'opus', '--print'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    let lastDot = Date.now();

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
      // Show progress dots every 500ms
      const now = Date.now();
      if (now - lastDot > 500) {
        process.stdout.write('.');
        lastDot = now;
      }
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code) => {
      process.stdout.write('\n'); // New line after progress dots
      if (code !== 0) {
        console.error(`\n❌ Claude CLI error (exit code ${code}):`);
        console.error(stderr);
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    claude.on('error', (error) => {
      reject(new Error(`Failed to spawn Claude CLI: ${error.message}`));
    });

    // Send prompt to stdin
    claude.stdin.write(prompt);
    claude.stdin.end();
  });
}

/**
 * Use Claude Opus to intelligently group commands
 */
export async function groupCommands(commands: CommandInfo[]): Promise<GroupingResult> {
  const prompt = generatePrompt(commands);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 Analyzing commands with Claude Opus...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const promptTokensEstimate = Math.ceil(prompt.length / 4); // rough estimate: ~4 chars per token
  console.log(`📊 Total commands to analyze: ${commands.length}`);
  console.log(`📝 Prompt: ${prompt.length} chars (~${promptTokensEstimate.toLocaleString()} tokens)`);

  // Show first few commands as sample
  console.log(`\n📋 Sample commands (first 5):`);
  commands.slice(0, 5).forEach((cmd, i) => {
    console.log(`   ${i + 1}. ${cmd.command} (${cmd.projects.length} project${cmd.projects.length > 1 ? 's' : ''})`);
  });
  if (commands.length > 5) {
    console.log(`   ... and ${commands.length - 5} more\n`);
  }

  console.log('🔄 Calling Claude CLI...\n');
  console.log('   Command: claude --model opus --print');
  console.log('   Waiting for response...\n');

  try {
    const response = await callClaudeCLI(prompt);

    const responseTokensEstimate = Math.ceil(response.length / 4);
    const inputCost = promptTokensEstimate * 15 / 1_000_000;  // Opus: $15/MTok input
    const outputCost = responseTokensEstimate * 75 / 1_000_000; // Opus: $75/MTok output
    const totalCost = inputCost + outputCost;

    console.log('✅ Received response from Claude');
    console.log(`📏 Response: ${response.length} chars (~${responseTokensEstimate.toLocaleString()} tokens)`);
    console.log(`💰 Estimated cost: $${totalCost.toFixed(4)} (in: $${inputCost.toFixed(4)}, out: $${outputCost.toFixed(4)})\n`);

    // Parse the JSON response
    let jsonText = response.trim();

    console.log('🔍 Parsing response...');

    // Remove markdown code blocks if present
    if (jsonText.startsWith('```json')) {
      console.log('   Removing JSON markdown formatting...');
      jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?$/g, '');
    } else if (jsonText.startsWith('```')) {
      console.log('   Removing markdown code blocks...');
      jsonText = jsonText.replace(/```\n?/g, '').replace(/```\n?$/g, '');
    }

    console.log('   Parsing JSON...');
    let result: GroupingResult;
    try {
      result = JSON.parse(jsonText);
    } catch (parseErr) {
      // Try to extract JSON object from response (Claude may include extra text)
      console.log('   ⚠️  Direct parse failed, attempting JSON extraction...');
      console.log(`   First 200 chars: ${jsonText.substring(0, 200)}`);
      console.log(`   Last 200 chars: ${jsonText.substring(jsonText.length - 200)}`);

      // Try extracting the outermost { ... } object
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`Could not find valid JSON object in Claude response. Parse error: ${parseErr}`);
      }
      try {
        result = JSON.parse(jsonMatch[0]);
      } catch {
        // Last resort: try fixing common issues like trailing commas
        const fixed = jsonMatch[0]
          .replace(/,\s*([\]}])/g, '$1')  // trailing commas
          .replace(/\n/g, ' ');           // newlines in strings
        result = JSON.parse(fixed);
      }
    }
    console.log('✅ Successfully parsed response\n');

    // Ensure required fields exist
    if (!Array.isArray(result.groupings)) result.groupings = [];
    if (!Array.isArray(result.ungrouped)) result.ungrouped = [];
    if (!result.statistics) {
      result.statistics = {
        totalCommands: commands.length,
        grouped: result.groupings.reduce((sum, g) => sum + g.matches.length, 0),
        ungrouped: result.ungrouped.length,
        categoryCounts: { SAFE_TO_WILDCARD: 0, MAYBE_SAFE: 0, NEVER_WILDCARD: 0 },
      };
    }

    // Validate groupings
    console.log('🛡️  Validating groupings for safety and logic...');
    const originalGroupingCount = result.groupings.length;

    result.groupings = result.groupings.filter(g => {
      // Safety check
      if (!validateGrouping(g.pattern)) {
        console.log(`   ⚠️  Blocked dangerous pattern: ${g.pattern}`);
        // Move to ungrouped
        result.ungrouped.push(...g.matches.map(cmd => ({
          command: cmd,
          reasoning: `Blocked by safety validation: pattern "${g.pattern}" contains dangerous commands`,
          shouldApprove: false,
          safetyCategory: 'NEVER_WILDCARD' as const,
          approved: null,
        })));
        return false;
      }

      // Logic check
      const logicCheck = validateGroupingLogic(g);
      if (!logicCheck.valid) {
        console.log(`   ⚠️  Rejected bad grouping: ${g.pattern}`);
        console.log(`      Reason: ${logicCheck.reason}`);
        // Move to ungrouped
        result.ungrouped.push(...g.matches.map(cmd => ({
          command: cmd,
          reasoning: `Rejected grouping: ${logicCheck.reason}`,
          shouldApprove: true,
          safetyCategory: 'SAFE_TO_WILDCARD' as const,
          approved: null,
        })));
        return false;
      }

      return true;
    });

    const blockedCount = originalGroupingCount - result.groupings.length;
    if (blockedCount > 0) {
      console.log(`   🚫 Blocked/rejected ${blockedCount} bad grouping${blockedCount > 1 ? 's' : ''}`);
    } else {
      console.log('   ✅ All groupings passed validation');
    }

    // Add approved: null to all items
    result.groupings = result.groupings.map(g => ({ ...g, approved: null }));
    result.ungrouped = result.ungrouped.map(u => ({ ...u, approved: null }));

    console.log('\n📊 Analysis Results:');
    console.log(`   Grouped patterns: ${result.groupings.length}`);
    console.log(`   Ungrouped commands: ${result.ungrouped.length}`);
    console.log(`   Total analyzed: ${result.statistics.totalCommands}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return result;
  } catch (error) {
    console.error('Error calling Claude Opus:', error);
    throw error;
  }
}
