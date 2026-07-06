import { IsString, MaxLength } from 'class-validator';

export class ParseCurlDto {
  @IsString() @MaxLength(100000)
  curl: string;
}
