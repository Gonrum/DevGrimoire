import { IsString, IsOptional, IsArray, ArrayUnique } from 'class-validator';

export class UpdateApiKeyDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @IsOptional()
  allowedTools?: string[] | null;
}
