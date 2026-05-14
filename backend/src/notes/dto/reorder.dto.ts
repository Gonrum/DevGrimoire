import { ArrayMaxSize, IsArray, IsMongoId } from 'class-validator';

export class ReorderDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  orderedIds: string[];
}
