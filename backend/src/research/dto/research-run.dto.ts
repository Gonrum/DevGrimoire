import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsMongoId, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import type { ResearchDepth } from '../research-types';

/** Multipart liefert `topics` als JSON-String, Einzelwert oder wiederholtes Feld. */
function toTopicList(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : value;
    } catch {
      return [value];
    }
  }
  return [value];
}

export class StartResearchDto {
  @Transform(({ value }: { value: unknown }) => toTopicList(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(3, 300, { each: true })
  topics: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  focus?: string;

  @IsOptional()
  @IsIn(['quick', 'normal', 'thorough'])
  depth?: ResearchDepth;

  @IsOptional()
  @Matches(/^(project|customer):[0-9a-f]{24}$/)
  moveTargetHint?: string;
}

export class DeepenDto {
  @IsString()
  @Length(3, 500)
  question: string;
}

export class MoveDto {
  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsOptional()
  @IsMongoId()
  customerId?: string;
}
