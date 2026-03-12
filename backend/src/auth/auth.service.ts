import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { RefreshToken, RefreshTokenDocument } from './schemas/refresh-token.schema';
import { User, UserDocument, UserRole } from './schemas/user.schema';

const AUTH_ENABLED = !!(process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD);
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;
const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private jwtService: JwtService,
    @InjectModel(RefreshToken.name) private refreshTokenModel: Model<RefreshTokenDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {
    this.seedAdminUser();
    // Clean up old refresh tokens from pre-migration (had username field instead of userId)
    this.refreshTokenModel.deleteMany({ userId: { $exists: false } }).exec().catch(() => {});
  }

  private async seedAdminUser(): Promise<void> {
    const username = process.env.AUTH_USERNAME;
    const password = process.env.AUTH_PASSWORD;
    if (!username || !password) {
      this.logger.warn('Authentication DISABLED: AUTH_USERNAME and AUTH_PASSWORD not set');
      return;
    }

    const existing = await this.userModel.findOne({ username }).exec();
    if (existing) {
      this.logger.log(`Admin user "${username}" already exists`);
      return;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await this.userModel.create({
      username,
      passwordHash,
      role: UserRole.ADMIN,
      active: true,
    });
    this.logger.log(`Admin user "${username}" created from environment variables`);
  }

  isAuthEnabled(): boolean {
    return AUTH_ENABLED;
  }

  async login(username: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
    if (!AUTH_ENABLED) {
      throw new UnauthorizedException('Authentication is not configured');
    }

    const user = await this.userModel.findOne({ username }).exec();
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.active) {
      throw new UnauthorizedException('Konto ist deaktiviert');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.generateRefreshToken(user._id.toString());

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

    const user = await this.userModel.findById(stored.userId).exec();
    if (!user || !user.active) {
      throw new UnauthorizedException('User not found or inactive');
    }

    const accessToken = this.generateAccessToken(user);
    const newRefreshToken = await this.generateRefreshToken(user._id.toString());

    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokenModel.deleteOne({ token: refreshToken }).exec();
  }

  async getAuthStatus(): Promise<{ enabled: boolean; authenticated: boolean }> {
    return { enabled: AUTH_ENABLED, authenticated: false };
  }

  // User management methods
  async findAllUsers(): Promise<UserDocument[]> {
    return this.userModel.find().select('-passwordHash').sort({ createdAt: -1 }).exec();
  }

  async findUserById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).select('-passwordHash').exec();
  }

  async createUser(data: {
    username: string;
    email?: string;
    password: string;
    role?: UserRole;
  }): Promise<UserDocument> {
    const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
    const user = await this.userModel.create({
      username: data.username,
      email: data.email,
      passwordHash,
      role: data.role || UserRole.USER,
      active: true,
    });
    const result = user.toObject();
    delete (result as any).passwordHash;
    return result as UserDocument;
  }

  async updateUser(id: string, data: {
    username?: string;
    email?: string;
    role?: UserRole;
    active?: boolean;
  }): Promise<UserDocument | null> {
    return this.userModel
      .findByIdAndUpdate(id, data, { new: true })
      .select('-passwordHash')
      .exec();
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await this.userModel.findByIdAndDelete(id).exec();
    if (result) {
      // Delete all refresh tokens for this user
      await this.refreshTokenModel.deleteMany({ userId: id }).exec();
    }
    return !!result;
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new UnauthorizedException('User not found');

    const valid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Altes Passwort ist falsch');

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await user.save();
  }

  async updateProfile(userId: string, data: { username?: string; email?: string }): Promise<UserDocument | null> {
    return this.userModel
      .findByIdAndUpdate(userId, data, { new: true })
      .select('-passwordHash')
      .exec();
  }

  private generateAccessToken(user: UserDocument): string {
    return this.jwtService.sign(
      { sub: user._id.toString(), username: user.username, role: user.role },
      { expiresIn: ACCESS_TOKEN_EXPIRY },
    );
  }

  private async generateRefreshToken(userId: string): Promise<string> {
    const token = randomBytes(48).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    await this.refreshTokenModel.create({ token, userId, expiresAt });

    return token;
  }
}
