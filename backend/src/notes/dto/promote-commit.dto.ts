import {
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export type PromoteEntityType =
  | 'knowledge'
  | 'snippet'
  | 'todo'
  | 'research'
  | 'manual';

export class PromoteCommitDto {
  @IsIn(['knowledge', 'snippet', 'todo', 'research', 'manual'])
  entityType: PromoteEntityType;

  @IsMongoId()
  @IsOptional()
  projectId?: string;

  @IsMongoId()
  @IsOptional()
  customerId?: string;

  @IsString()
  @MaxLength(200)
  title: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  reasoning?: string;
}
