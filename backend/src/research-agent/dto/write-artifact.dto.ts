import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * Body for `PUT /research-topics/:id/artifacts/:slug` (manual edit path).
 * `slug` is deliberately NOT a field here — it comes from the URL param, the
 * resource being addressed, not something the body can override. `runId` is
 * likewise omitted: it is stamped exclusively by the research agent itself
 * (see `ResearchAgentService.buildToolContext`'s `artifacts.write` closure)
 * to attribute a write to the run that produced it — a manual/UI edit has no
 * run to attribute itself to.
 *
 * Mirrors `WriteArtifactInput` (research-artifact.service.ts) minus
 * `slug`/`runId`.
 */
export class WriteResearchArtifactDto {
  @IsString()
  title: string;

  @IsString()
  content: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sources?: string[];

  @IsOptional()
  @IsString()
  changeNote?: string;
}
