import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsMongoId, IsOptional } from 'class-validator';

/** Body of `POST /api/oauth/requests/:id/decision`. */
export class OAuthDecisionDto {
  @IsBoolean()
  approve!: boolean;

  /** Restrict the connection to these projects; omit for an unrestricted one. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsMongoId({ each: true })
  projectIds?: string[];
}
