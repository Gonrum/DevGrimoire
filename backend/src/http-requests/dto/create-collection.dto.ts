import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateCollectionDto {
  @IsOptional() @IsString() projectId?: string; // meist aus Route-Param

  @IsString() @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsInt() @Min(0)
  order?: number;
}
