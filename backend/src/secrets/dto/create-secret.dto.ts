import { IsString, IsOptional, IsMongoId, IsIn } from 'class-validator';

const SECRET_TYPES = ['variable', 'password', 'token', 'ssh_key', 'certificate', 'file'] as const;

export class CreateSecretDto {
  @IsMongoId()
  projectId: string;

  @IsMongoId()
  @IsOptional()
  environmentId?: string;

  @IsString()
  key: string;

  @IsString()
  value: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsIn(SECRET_TYPES)
  @IsOptional()
  type?: string;
}
