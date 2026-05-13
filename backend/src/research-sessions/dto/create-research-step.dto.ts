import { IsOptional, IsString } from 'class-validator';

export class CreateResearchStepDto {
  @IsString()
  title: string;

  @IsOptional()
  order?: number;
}
