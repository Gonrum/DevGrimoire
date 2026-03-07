import { IsString, IsOptional } from 'class-validator';

export class UpdateSecretDto {
  @IsString()
  @IsOptional()
  key?: string;

  @IsString()
  @IsOptional()
  value?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
