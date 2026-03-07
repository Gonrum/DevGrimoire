import { IsString, IsOptional, IsMongoId } from 'class-validator';

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
}
