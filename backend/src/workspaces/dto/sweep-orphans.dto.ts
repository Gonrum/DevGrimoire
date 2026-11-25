import { IsBoolean, IsOptional } from 'class-validator';

export class SweepOrphansDto {
  /** Dry run unless this is exactly `true`. */
  @IsOptional()
  @IsBoolean()
  delete?: boolean;
}
