import { IsBoolean, IsOptional } from 'class-validator';

/**
 * POST /api/ssh-connections/:id/test
 *
 * Body is optional. `forceRetry` is reserved for the UI to indicate that the
 * user re-clicked "Test" after a failure; the service treats it the same as
 * a normal call today but the flag lets us add backoff logic later without
 * breaking the client.
 */
export class TestSshConnectionDto {
  @IsOptional()
  @IsBoolean()
  forceRetry?: boolean;
}
