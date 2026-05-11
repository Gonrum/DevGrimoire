import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { EncryptionService } from '../common/encryption.service';
import {
  UpdateWorkflowAgentConfigDto,
  WorkflowAgentConfigPublic,
  WorkflowAgentProvider,
} from './dto/workflow-agent.dto';

const SETTING_KEY = 'workflow_agent_endpoint_v1';

interface StoredEndpoint {
  provider: WorkflowAgentProvider;
  url: string;
  model: string;
  apiKeyEncrypted?: string;
  toolsEnabled: boolean;
  maxToolIterations: number;
}

export interface WorkflowAgentEndpoint {
  provider: WorkflowAgentProvider;
  url: string;
  model: string;
  apiKey?: string;
  toolsEnabled: boolean;
  maxToolIterations: number;
}

@Injectable()
export class WorkflowAgentService {
  private readonly logger = new Logger(WorkflowAgentService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly encryption: EncryptionService,
  ) {}

  async getConfig(): Promise<WorkflowAgentConfigPublic | null> {
    const raw = await this.settings.get(SETTING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredEndpoint;
    return {
      provider: parsed.provider,
      url: parsed.url,
      model: parsed.model,
      hasApiKey: !!parsed.apiKeyEncrypted && parsed.apiKeyEncrypted.length > 0,
      toolsEnabled: parsed.toolsEnabled,
      maxToolIterations: parsed.maxToolIterations,
    };
  }

  async setConfig(dto: UpdateWorkflowAgentConfigDto): Promise<void> {
    const previous = await this.loadEndpoint();
    let apiKeyEncrypted: string | undefined;
    if (dto.apiKey === undefined) {
      apiKeyEncrypted = previous?.apiKey ? this.encryption.encrypt(previous.apiKey) : undefined;
    } else if (dto.apiKey === '') {
      apiKeyEncrypted = undefined;
    } else {
      apiKeyEncrypted = this.encryption.encrypt(dto.apiKey);
    }
    const stored: StoredEndpoint = {
      provider: dto.provider,
      url: dto.url,
      model: dto.model,
      apiKeyEncrypted,
      toolsEnabled: dto.toolsEnabled,
      maxToolIterations: dto.maxToolIterations,
    };
    await this.settings.set(SETTING_KEY, JSON.stringify(stored));
  }

  async loadEndpoint(): Promise<WorkflowAgentEndpoint | null> {
    const raw = await this.settings.get(SETTING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredEndpoint;
    return {
      provider: parsed.provider,
      url: parsed.url,
      model: parsed.model,
      apiKey: parsed.apiKeyEncrypted ? this.encryption.decrypt(parsed.apiKeyEncrypted) : undefined,
      toolsEnabled: parsed.toolsEnabled,
      maxToolIterations: parsed.maxToolIterations,
    };
  }
}
