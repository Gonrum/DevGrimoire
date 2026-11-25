import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, Matches } from 'class-validator';

export class SweepOrphansDto {
  /** Dry run unless this is exactly `true`. */
  @IsOptional()
  @IsBoolean()
  delete?: boolean;

  /** Required with `delete: true`: the orphan ids the dry run listed. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @Matches(/^[a-f0-9]{24}$/, { each: true })
  ids?: string[];
}
