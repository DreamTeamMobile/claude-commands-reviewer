export interface SessionInfo {
  id: string;
  branch: string;
  lastActivity: string;
}

export interface ProjectInfo {
  path: string;
  sessions: SessionInfo[];
  worktreeCount: number;
  branches: string[];
}

export interface ProjectsMap {
  [projectPath: string]: ProjectInfo;
}

export interface CommandInfo {
  command: string;
  projects: string[];
}

export interface AggregatedCommands {
  allowedCommands: CommandInfo[];
  deniedCommands: CommandInfo[];
}

export interface Grouping {
  pattern: string;
  matches: string[];
  reasoning: string;
  confidence: 'high' | 'medium' | 'low';
  safetyCategory: 'SAFE_TO_WILDCARD' | 'MAYBE_SAFE' | 'NEVER_WILDCARD' | 'MCP_SERVER';
  approved: boolean | null;
  groupType?: 'mcp-server' | 'standard';
  mcpChoice?: 'server' | 'individual';
}

export interface UngroupedCommand {
  command: string;
  reasoning: string;
  shouldApprove: boolean;
  safetyCategory: 'SAFE_TO_WILDCARD' | 'MAYBE_SAFE' | 'NEVER_WILDCARD' | 'MCP_SERVER';
  approved: boolean | null;
}

export interface GroupingResult {
  groupings: Grouping[];
  ungrouped: UngroupedCommand[];
  statistics: {
    totalCommands: number;
    grouped: number;
    ungrouped: number;
    categoryCounts: {
      SAFE_TO_WILDCARD: number;
      MAYBE_SAFE: number;
      NEVER_WILDCARD: number;
    };
  };
}

export interface ReviewFile {
  date: string;
  groupings: Grouping[];
  ungrouped: UngroupedCommand[];
  statistics: {
    totalProjects: number;
    totalCommands: number;
    grouped: number;
    ungrouped: number;
  };
}

export interface OrchestratorState {
  lastCollectRun: string | null;
}

export interface ProjectSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface JSONLEntry {
  sessionId: string;
  cwd: string;
  gitBranch: string;
  timestamp: string;
  type: string;
  [key: string]: any;
}
