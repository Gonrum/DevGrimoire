import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ChatActivityService } from './chat-activity.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/schemas/user.schema';
import { ChatActivityOutcome } from './schemas/chat-activity.schema';

const VALID_OUTCOMES: ChatActivityOutcome[] = ['completed', 'aborted', 'failed', 'no_endpoint'];

/**
 * Admin-only read API for the chat-activity log. Powers the Settings → Chat-Log
 * tab so admins can spot flaky endpoints, frequent tool errors, and failed
 * runs without grepping through server logs.
 */
@Controller('chat-activity')
@Roles(UserRole.ADMIN)
export class ChatActivityController {
  constructor(private readonly activity: ChatActivityService) {}

  @Get()
  async list(
    @Query('projectId') projectId?: string,
    @Query('sessionId') sessionId?: string,
    @Query('outcome') outcome?: string,
    @Query('provider') provider?: string,
    @Query('search') search?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    // `find` statt `includes` + Assertion: der verengte Typ entsteht aus der
    // Laufzeitprüfung. Ein leerer `outcome`-Parameter bleibt wie vorher ohne
    // Filterwirkung, statt eine 400 auszulösen.
    const parsedOutcome = VALID_OUTCOMES.find((candidate) => candidate === outcome);
    if (outcome && !parsedOutcome) {
      throw new BadRequestException(`Invalid outcome: ${outcome}`);
    }
    return this.activity.list({
      projectId,
      sessionId,
      outcome: parsedOutcome,
      provider,
      search,
      startDate: startDate ? this.parseDate(startDate, 'startDate') : undefined,
      endDate: endDate ? this.parseDate(endDate, 'endDate') : undefined,
      limit: limit ? this.parseInt(limit, 'limit') : undefined,
      offset: offset ? this.parseInt(offset, 'offset') : undefined,
    });
  }

  @Get('stats')
  async stats(
    @Query('projectId') projectId?: string,
    @Query('days') days?: string,
  ) {
    return this.activity.stats({
      projectId,
      days: days ? this.parseInt(days, 'days') : 30,
    });
  }

  private parseInt(value: string, field: string): number {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) throw new BadRequestException(`Invalid ${field}: ${value}`);
    return n;
  }

  private parseDate(value: string, field: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${field}: ${value}`);
    return d;
  }
}
