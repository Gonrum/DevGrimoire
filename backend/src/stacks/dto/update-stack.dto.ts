import { IsOptional, IsString } from 'class-validator';

export class UpdateStackDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
