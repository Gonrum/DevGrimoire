import { Controller, Post, Body, HttpCode, HttpStatus, Get, Patch, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Public } from './decorators/public.decorator';
import type { AuthRequest } from '../common/request-context';

/**
 * Zwei Request-Typen, weil zwei Sorten Endpunkte:
 *
 * - `login`/`refresh` sind `@Public()`, dort gibt es noch keinen Actor. Sie
 *   lesen nur Transport-Metadaten (`ip`, `user-agent`) → Express-`Request`.
 *   `req.headers['user-agent']` ist in `IncomingHttpHeaders` als
 *   `string | undefined` deklariert (kein `string[]`), passt also direkt auf
 *   `clientInfo.userAgent` — anders als Query-Parameter, die `string[]` sein
 *   können.
 * - die Profil-Endpunkte laufen nur mit angehängtem Actor → `AuthRequest`
 *   aus `common/request-context` (kanonische Fassung, inkl. `role`,
 *   `permissions` und beider Scope-Achsen).
 *
 * `req.user!` in den Profil-Handlern hält das Laufzeitverhalten exakt: der
 * `JwtAuthGuard` setzt `user` auf jeder nicht-`@Public()`-Route. Einzige
 * Ausnahme ist der Modus "Authentifizierung deaktiviert" (AUTH_USERNAME /
 * AUTH_PASSWORD nicht gesetzt) — dort lässt der Guard alles ohne `user`
 * durch und diese Handler liefen schon vorher in einen TypeError (HTTP 500).
 * Das ist bewusst unverändert: aus dem Crash ein 401 zu machen, wäre eine
 * Verhaltensänderung an einem Auth-Pfad. Kein `undefined` erreicht dabei eine
 * Mongo-Query.
 */
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto.username, dto.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @Post('refresh')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(dto.refreshToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshDto) {
    await this.authService.logout(dto.refreshToken);
  }

  @Public()
  @Get('status')
  status() {
    return this.authService.getAuthStatus();
  }

  @Get('profile')
  async getProfile(@Req() req: AuthRequest) {
    return this.authService.findUserById(req.user!.userId);
  }

  @Patch('profile')
  async updateProfile(@Req() req: AuthRequest, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(req.user!.userId, dto);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(@Req() req: AuthRequest, @Body() dto: ChangePasswordDto) {
    await this.authService.changePassword(req.user!.userId, dto.oldPassword, dto.newPassword);
    return { message: 'Passwort geändert' };
  }
}
