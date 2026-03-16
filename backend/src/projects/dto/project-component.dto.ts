import { IsString, IsOptional } from 'class-validator';

export class ProjectComponentDto {
  @IsString()
  name: string;

  @IsString()
  version: string;

  @IsString()
  @IsOptional()
  path?: string;
}
