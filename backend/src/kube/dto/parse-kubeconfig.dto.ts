import { IsString, MaxLength, MinLength } from 'class-validator';

export class ParseKubeconfigDto {
  @IsString() @MinLength(1) @MaxLength(512 * 1024)
  kubeconfig: string;
}
