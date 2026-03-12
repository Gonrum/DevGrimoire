import { IsString, IsOptional, IsNumber } from 'class-validator';

export class UpdateManualDto {
  @IsString()
  @IsOptional()
  title?: string;

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
