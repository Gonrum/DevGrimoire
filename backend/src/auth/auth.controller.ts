import { Controller, Post, Body, HttpCode, HttpStatus, Get, Patch, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { Public } from './decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.username, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshDto) {
    await this.authService.logout(dto.refreshToken);
  }

  @Public()
  @Get('status')
  async status() {
    return this.authService.getAuthStatus();
  }

  @Get('profile')
  async getProfile(@Req() req: any) {
    return this.authService.findUserById(req.user.userId);
  }

  @Patch('profile')
  async updateProfile(@Req() req: any, @Body() body: { username?: string; email?: string }) {
    return this.authService.updateProfile(req.user.userId, body);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(@Req() req: any, @Body() body: { oldPassword: string; newPassword: string }) {
    await this.authService.changePassword(req.user.userId, body.oldPassword, body.newPassword);
    return { message: 'Passwort geändert' };
  }
}
