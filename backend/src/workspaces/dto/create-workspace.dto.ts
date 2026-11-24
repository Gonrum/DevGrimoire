import { ArrayMaxSize, IsArray, IsIn, IsMongoId, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { WORKSPACE_AGENT_TOOL_SETS, WorkspaceAgentToolSet } from '../agent-tool-sets';
import { WORKSPACE_LOCATIONS, WORKSPACE_NAME_PATTERN, WorkspaceLocation } from '../schemas/workspace.schema';

export class CreateWorkspaceDto {
  @IsMongoId()
  projectId: string;

  @IsString()
  @MaxLength(64)
  @Matches(WORKSPACE_NAME_PATTERN, {
    message:
      'name must start with [a-z0-9] and contain only [a-z0-9_-] (max 64 chars) — used as a directory segment',
  })
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  repoUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  branch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  createdBySessionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(48)
  gitRepoId?: string;

  @IsOptional()
  @IsIn(WORKSPACE_LOCATIONS)
  location?: WorkspaceLocation;

  @IsOptional()
  @IsMongoId()
  sshConnectionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  remotePath?: string;

  /** Extra tool sets of the IDE agent besides ws_*; each entry one of WORKSPACE_AGENT_TOOL_SETS. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WORKSPACE_AGENT_TOOL_SETS.length * 2)
  @IsIn(WORKSPACE_AGENT_TOOL_SETS, { each: true })
  agentToolSets?: WorkspaceAgentToolSet[];
}
