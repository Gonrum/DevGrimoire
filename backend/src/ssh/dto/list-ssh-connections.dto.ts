import { IsMongoId, IsOptional } from 'class-validator';

/**
 * GET /api/ssh-connections?customerId&projectId
 *
 * Exactly one of customerId / projectId must be set — same invariant the
 * underlying connection scope obeys. The controller enforces this since
 * class-validator can't express XOR cleanly.
 */
export class ListSshConnectionsDto {
  @IsOptional()
  @IsMongoId()
  customerId?: string;

  @IsOptional()
  @IsMongoId()
  projectId?: string;
}
