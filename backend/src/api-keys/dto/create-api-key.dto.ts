import { IsString, IsOptional, IsDateString } from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  name: string;

  @IsDateString()
  @IsOptional()
  expiresAt?: string;
}
