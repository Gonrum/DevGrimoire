import { IsOptional, IsString } from 'class-validator';

export class CreateStackEntryDto {
  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  content?: string;
}
