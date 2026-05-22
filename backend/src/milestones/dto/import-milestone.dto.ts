import { IsString, IsNotEmpty, IsMongoId, IsObject } from 'class-validator';
import { ParsedMilestone } from '../milestones.service';

export class ImportPreviewDto {
  @IsString()
  @IsNotEmpty()
  markdown: string;
}

export class ImportApplyDto {
  @IsMongoId()
  projectId: string;

  // Parser produces clean data; @IsObject() keeps ValidationPipe from stripping the field
  @IsObject()
  parsed: ParsedMilestone;
}
