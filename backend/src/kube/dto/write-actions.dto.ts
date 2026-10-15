import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DELETABLE_KINDS, RESTARTABLE_KINDS, SCALABLE_KINDS } from '../kube-writes.service';

/**
 * Body der Schreibaktionen unter POST /api/kube-clusters/:id/actions/*.
 * Die DTOs prüfen nur die Form; readOnly, Scope und die Kind-Erlaubnis
 * entscheidet der Service, damit MCP dieselben Pfade nutzt.
 */
export class ScaleActionDto {
  @IsIn([...SCALABLE_KINDS]) kind!: string;
  @IsString() @MinLength(1) @MaxLength(253) name!: string;
  @IsString() @MinLength(1) @MaxLength(253) namespace!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(1000) replicas!: number;
}

export class RestartActionDto {
  @IsIn([...RESTARTABLE_KINDS]) kind!: string;
  @IsString() @MinLength(1) @MaxLength(253) name!: string;
  @IsString() @MinLength(1) @MaxLength(253) namespace!: string;
}

export class DeleteActionDto {
  @IsIn([...DELETABLE_KINDS]) kind!: string;
  @IsString() @MinLength(1) @MaxLength(253) name!: string;
  @IsString() @MinLength(1) @MaxLength(253) namespace!: string;
}

export class CordonActionDto {
  @IsString() @MinLength(1) @MaxLength(253) node!: string;
  @IsBoolean() unschedulable!: boolean;
}

export class ApplyActionDto {
  @IsString() @MinLength(1) @MaxLength(256 * 1024) yaml!: string;
  @IsString() @MinLength(1) @MaxLength(253) namespace!: string;
}
