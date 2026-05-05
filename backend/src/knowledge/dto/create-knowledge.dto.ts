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
  @ValidateIf((o) => o.scope === 'project')
  projectId?: string;

  @IsMongoId()
  @ValidateIf((o) => o.scope === 'customer')
  customerId?: string;

  @IsIn(['global', 'project', 'customer'])
  @IsOptional()
  scope?: 'global' | 'project' | 'customer';

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
