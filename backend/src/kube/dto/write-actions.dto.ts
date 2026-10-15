import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
  DELETABLE_KINDS, KUBE_APPLY_YAML_MAX, RESTARTABLE_KINDS, SCALABLE_KINDS,
} from '../kube-writes.service';

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

/**
 * Server-Side Apply, Feldbesitzer `devgrimoire`, ohne force: ein Konflikt mit
 * einem anderen Feldbesitzer ist ein Fehler. Erlaubte Kinds: `APPLYABLE_KINDS`
 * (kube-writes.service.ts) — der Service prüft sie pro Dokument, das DTO nur
 * die Form.
 */
export class ApplyActionDto {
  @IsString() @MinLength(1) @MaxLength(KUBE_APPLY_YAML_MAX) yaml!: string;
  @IsString() @MinLength(1) @MaxLength(253) namespace!: string;
}
