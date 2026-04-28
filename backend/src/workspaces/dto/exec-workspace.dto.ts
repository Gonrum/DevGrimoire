import { IsObject, IsOptional, IsString, MaxLength, Min, Max, IsInt } from 'class-validator';

export class ExecWorkspaceDto {
  @IsString()
  @MaxLength(8 * 1024)
  command: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600_000)
  timeout?: number;

  @IsOptional()
  @IsObject()
  env?: Record<string, string>;
}
