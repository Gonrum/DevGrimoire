import { IsString, IsOptional, IsMongoId } from 'class-validator';

export class SaveManualDto {
  @IsMongoId()
  projectId: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  content: string;

  @IsString()
  @IsOptional()
  lastEditedBy?: string;
}
