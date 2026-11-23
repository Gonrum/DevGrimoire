import { IsIn, IsMongoId, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
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
}
