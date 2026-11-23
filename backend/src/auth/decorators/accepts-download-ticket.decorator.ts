import { SetMetadata } from '@nestjs/common';

export const ACCEPTS_DOWNLOAD_TICKET_KEY = 'acceptsDownloadTicket';

/**
 * Marks a GET route that may also be reached with `?ticket=` instead of a
 * Bearer header (browser downloads). `JwtAuthGuard` lets such a request pass
 * only for a ticket that is valid and bound to this workspace and path; the
 * route itself consumes the ticket and re-checks the user.
 */
export const AcceptsDownloadTicket = () => SetMetadata(ACCEPTS_DOWNLOAD_TICKET_KEY, true);
