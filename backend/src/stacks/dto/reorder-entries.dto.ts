import { IsArray, IsMongoId } from 'class-validator';

export class ReorderEntriesDto {
  @IsArray()
  @IsMongoId({ each: true })
  entryIds: string[];
}
