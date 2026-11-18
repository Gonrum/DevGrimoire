import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, ValidateNested } from 'class-validator';
import { CreateLogDto } from './create-log.dto';

/**
 * Body of `POST /logs/batch`. Used to be an inline type `{ logs: CreateLogDto[] }`,
 * which the ValidationPipe cannot see through — the entries (including
 * `projectId`) reached the service completely unvalidated.
 */
export class CreateLogBatchDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CreateLogDto)
  logs: CreateLogDto[];
}
