import { IsString, IsOptional, IsArray, IsMongoId } from 'class-validator';

export class CreateAttachmentDto {
  @IsMongoId()
  projectId: string;

  @IsString()
  @IsOptional()
  entityType?: string;

  @IsMongoId()
  @IsOptional()
  entityId?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
