import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { resolveJwtSecret } from '../../common/jwt-secret';
import { JWT_ALGORITHM, accessTokenUserId } from '../../common/access-token';

export interface JwtPayload {
  typ?: string;
  sub: string;
  username: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: resolveJwtSecret(),
      algorithms: [JWT_ALGORITHM],
    });
  }

  /**
   * Nur Access-Tokens. Ein dg-CLI-Token ist mit demselben Secret signiert und
   * wäre sonst hier gültig; `false` macht daraus einen 401.
   */
  validate(payload: JwtPayload) {
    const userId = accessTokenUserId(payload);
    if (!userId) return false;
    return { userId, username: payload.username, role: payload.role };
  }
}
