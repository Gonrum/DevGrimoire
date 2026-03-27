import {
  IsString,
  IsOptional,
  IsArray,
  IsMongoId,
  IsIn,
  ValidateIf,
} from 'class-validator';

export class CreateKnowledgeDto {
  @IsMongoId()
  @ValidateIf((o) => o.scope !== 'global')
  projectId?: string;

  @IsIn(['global', 'project'])
  @IsOptional()
  scope?: 'global' | 'project';

  @IsString()
  topic: string;

  @IsString()
  content: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  category?: string;
}
