import { IsString, IsOptional, IsIn, IsBoolean } from 'class-validator';
import { GIT_PROVIDERS, GitProvider } from '../schemas/git-repository.schema';

export class ValidateTokenDto {
  /**
   * Deklariert als `GitProvider`, nicht als `string`: die Validierung lässt
   * ohnehin nur diese drei Werte durch, und der Controller musste den Wert
   * sonst per Assertion in den Repo-Typ zurückbehaupten.
   */
  @IsIn(GIT_PROVIDERS)
  provider: GitProvider;

  @IsString()
  @IsOptional()
  baseUrl?: string;

  @IsString()
  @IsOptional()
  owner?: string;

  @IsString()
  @IsOptional()
  repo?: string;

  @IsString()
  @IsOptional()
  gitlabProjectId?: string;

  @IsBoolean()
  @IsOptional()
  allowPrivateHost?: boolean;

  @IsString()
  token: string;
}
