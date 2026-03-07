import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { RefreshToken, RefreshTokenDocument } from './schemas/refresh-token.schema';

const AUTH_USERNAME = process.env.AUTH_USERNAME;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
const AUTH_ENABLED = !!(AUTH_USERNAME && AUTH_PASSWORD);

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private passwordHash: string | null = null;

  constructor(
    private jwtService: JwtService,
    @InjectModel(RefreshToken.name) private refreshTokenModel: Model<RefreshTokenDocument>,
  ) {
    if (AUTH_ENABLED) {
      bcrypt.hash(AUTH_PASSWORD!, 10).then((hash) => {
        this.passwordHash = hash;
        this.logger.log('Authentication enabled');
      });
    } else {
      this.logger.warn('Authentication DISABLED: AUTH_USERNAME and AUTH_PASSWORD not set');
    }
  }

  isAuthEnabled(): boolean {
    return AUTH_ENABLED;
  }

  async login(username: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
    if (!AUTH_ENABLED) {
      throw new UnauthorizedException('Authentication is not configured');
    }

    if (username !== AUTH_USERNAME || !this.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, this.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessToken = this.generateAccessToken(username);
    const refreshToken = await this.generateRefreshToken(username);

    return { accessToken, refreshToken };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const stored = await this.refreshTokenModel.findOne({ token: refreshToken }).exec();
    if (!stored || stored.expiresAt < new Date()) {
      if (stored) await stored.deleteOne();
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Rotate: delete old, create new
    await stored.deleteOne();

    const accessToken = this.generateAccessToken(stored.username);
    const newRefreshToken = await this.generateRefreshToken(stored.username);

    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokenModel.deleteOne({ token: refreshToken }).exec();
  }

  async getAuthStatus(): Promise<{ enabled: boolean; authenticated: boolean }> {
    return { enabled: AUTH_ENABLED, authenticated: false };
  }

  private generateAccessToken(username: string): string {
    return this.jwtService.sign(
      { sub: username, username },
      { expiresIn: ACCESS_TOKEN_EXPIRY },
    );
  }

  private async generateRefreshToken(username: string): Promise<string> {
    const token = randomBytes(48).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    await this.refreshTokenModel.create({ token, username, expiresAt });

    return token;
  }
}
