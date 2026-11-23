import { Type } from 'class-transformer';
import { SSH_AUDIT_SOURCE_CONTEXTS, SshAuditSourceContext } from '../schemas/ssh-audit.schema';
import {
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/**
 * GET /api/ssh-connections/:id/audit?limit&offset&sourceContext
 *
 * Pagination uses limit/offset to mirror the monitoring history pattern.
 * `sourceContext` filters the audit trail to entries from a specific source
 * (terminal | mcp | rest | workflow | dg | ide).
 */
export class AuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @IsIn([...SSH_AUDIT_SOURCE_CONTEXTS])
  sourceContext?: SshAuditSourceContext;
}
