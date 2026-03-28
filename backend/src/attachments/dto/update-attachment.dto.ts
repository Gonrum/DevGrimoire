import { IsString, IsOptional, IsArray, IsMongoId } from 'class-validator';

export class UpdateAttachmentDto {
  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  entityType?: string;

  @IsMongoId()
  @IsOptional()
  entityId?: string;
}
