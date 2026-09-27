import { agentTools } from './agents.js';
import { assetTools } from './assets.js';
import { fileTools } from './files.js';
import { gitTools } from './git.js';
import { projectTools } from './projects.js';
import type { AnyTool } from './registry.js';
import { taskTools } from './tasks.js';
import { activityTools, changeTools, decisionTools, knowledgeTools, messageTools, testTools } from './team.js';

export const ALL_TOOLS: AnyTool[] = [
  ...projectTools,
  ...agentTools,
  ...taskTools,
  ...fileTools,
  ...assetTools,
  ...gitTools,
  ...changeTools,
  ...decisionTools,
  ...messageTools,
  ...knowledgeTools,
  ...testTools,
  ...activityTools,
];

export const TOOLS_BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));

export type ToolProfile = 'full' | 'core';

export const toolsFor = (profile: ToolProfile) => (profile === 'core' ? ALL_TOOLS.filter((t) => t.core) : ALL_TOOLS);
