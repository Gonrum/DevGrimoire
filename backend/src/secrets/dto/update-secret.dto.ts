import { IsString, IsOptional, IsIn } from 'class-validator';

const SECRET_TYPES = ['variable', 'password', 'token', 'ssh_key', 'certificate', 'file'] as const;

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

  @IsString()
  @IsIn(SECRET_TYPES)
  @IsOptional()
  type?: string;
}
