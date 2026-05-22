import { IsString, IsNotEmpty, IsMongoId } from 'class-validator';

export class ImportPreviewDto {
  @IsString()
  @IsNotEmpty()
  markdown: string;
}

export class ImportApplyDto {
  @IsMongoId()
  projectId: string;

  // Parser produces clean data; pragmatic untyped to avoid excessive ValidateNested depth
  parsed: any;
}
