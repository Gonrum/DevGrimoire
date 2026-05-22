import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AiCompleteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50000)
  summaryMarkdown: string;
}
