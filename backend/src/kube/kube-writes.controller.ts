import { Body, Controller, HttpCode, Logger, Param, Post, Req } from '@nestjs/common';
import { KubeWritesService } from './kube-writes.service';
import { guardClusterErrors } from './kube-resources.controller';
import { AuthRequest, RequestContext } from '../common/request-context';
import {
  ApplyActionDto, CordonActionDto, DeleteActionDto, RestartActionDto, ScaleActionDto,
} from './dto/write-actions.dto';

/**
 * Schreibaktionen auf einem Cluster. Jede Route setzt `readOnly: false`
 * voraus — das prüft der Service, damit MCP dieselbe Grenze erbt.
 *
 * T-477: Die Scope-Prüfung sitzt hier bereits im Service (`canAccessCluster`),
 * anders als bei den lesenden Routen aus K2. Wenn die globale Regel kommt,
 * ersetzt sie diese Stelle.
 */
@Controller('kube-clusters')
export class KubeWritesController {
  private readonly logger = new Logger(KubeWritesController.name);

  constructor(private readonly writes: KubeWritesService) {}

  private ctx(req: AuthRequest) {
    return { actor: RequestContext.getUser(), userId: req.user?.userId || 'system' };
  }

  @Post(':id/actions/scale')
  @HttpCode(200)
  scale(@Param('id') id: string, @Body() dto: ScaleActionDto, @Req() req: AuthRequest) {
    return guardClusterErrors(() => this.writes.scale({ clusterId: id, ...dto, ...this.ctx(req) }), this.logger);
  }

  @Post(':id/actions/restart')
  @HttpCode(200)
  restart(@Param('id') id: string, @Body() dto: RestartActionDto, @Req() req: AuthRequest) {
    return guardClusterErrors(() => this.writes.restart({ clusterId: id, ...dto, ...this.ctx(req) }), this.logger);
  }

  @Post(':id/actions/delete')
  @HttpCode(200)
  remove(@Param('id') id: string, @Body() dto: DeleteActionDto, @Req() req: AuthRequest) {
    return guardClusterErrors(() => this.writes.remove({ clusterId: id, ...dto, ...this.ctx(req) }), this.logger);
  }

  @Post(':id/actions/cordon')
  @HttpCode(200)
  cordon(@Param('id') id: string, @Body() dto: CordonActionDto, @Req() req: AuthRequest) {
    return guardClusterErrors(() => this.writes.cordon({ clusterId: id, ...dto, ...this.ctx(req) }), this.logger);
  }

  @Post(':id/actions/apply')
  @HttpCode(200)
  apply(@Param('id') id: string, @Body() dto: ApplyActionDto, @Req() req: AuthRequest) {
    return guardClusterErrors(() => this.writes.apply({ clusterId: id, ...dto, ...this.ctx(req) }), this.logger);
  }
}
