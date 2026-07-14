import { IsOptional, IsString } from 'class-validator';

export class CreateStackDto {
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;
}
