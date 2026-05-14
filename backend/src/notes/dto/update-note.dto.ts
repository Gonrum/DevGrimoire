import { IsOptional, IsString, MaxLength } from 'class-validator';

const MAX_CONTENT_BYTES = 100 * 1024;

export class UpdateNoteDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  title?: string;

  @IsString()
  @IsOptional()
  @MaxLength(MAX_CONTENT_BYTES)
  content?: string;
}
