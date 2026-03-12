import { IsString, IsOptional, IsMongoId, IsNumber } from 'class-validator';

export class CreateManualDto {
  @IsMongoId()
  projectId: string;

  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsOptional()
  category?: string;

  @IsNumber()
  @IsOptional()
  sortOrder?: number;

  @IsString()
  @IsOptional()
  lastEditedBy?: string;
}
