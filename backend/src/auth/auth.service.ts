import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { RefreshToken, RefreshTokenDocument } from './schemas/refresh-token.schema';
import { User, UserDocument, UserRole, UserLlmConfig } from './schemas/user.schema';
import { LlmConfigDto } from './dto/update-profile.dto';
import { EncryptionService } from '../common/encryption.service';

const API_KEY_MASK = '***';
// AES-GCM encrypted values use the format `<ivHex>:<tagHex>:<cipherHex>` —
// detect whether a stored apiKey has already been encrypted.
const ENCRYPTED_PATTERN = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;

const AUTH_ENABLED = !!(process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD);
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;
const BCRYPT_ROUNDS = 10;

export interface ActiveUserSummary {
  userId: string;
  username: string;
  role: UserRole;
  lastSeenAt: Date;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private jwtService: JwtService,
    @InjectModel(RefreshToken.name) private refreshTokenModel: Model<RefreshTokenDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly encryptionService: EncryptionService,
  ) {
    this.seedAdminUser();
    // Clean up old refresh tokens from pre-migration (had username field instead of userId)
    this.refreshTokenModel.deleteMany({ userId: { $exists: false } }).exec().catch(() => {});
    // Encrypt any plaintext llmConfig.apiKey values (T-57 migration)
    this.migrateLegacyApiKeys().catch(() => {});
  }

  private async migrateLegacyApiKeys(): Promise<void> {
    if (!this.encryptionService.isEnabled()) return;
    try {
      const candidates = await this.userModel
        .find({ 'llmConfig.apiKey': { $exists: true, $ne: '' } })
        .select('llmConfig')
        .exec();
      let migrated = 0;
      for (const user of candidates) {
        const current = user.llmConfig?.apiKey;
        if (!current || ENCRYPTED_PATTERN.test(current)) continue;
        const encrypted = this.encryptionService.encrypt(current);
        await this.userModel
          .updateOne({ _id: user._id }, { $set: { 'llmConfig.apiKey': encrypted } })
          .exec();
        migrated += 1;
      }
      if (migrated > 0) {
        this.logger.log(`Encrypted ${migrated} legacy plaintext llmConfig.apiKey value(s).`);
      }
    } catch (err) {
      this.logger.warn(`llmConfig.apiKey migration failed: ${(err as Error).message}`);
    }
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

  async login(username: string, password: string, clientInfo?: { ip?: string; userAgent?: string }): Promise<{ accessToken: string; refreshToken: string }> {
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
    const refreshToken = await this.generateRefreshToken(user._id.toString(), clientInfo);

    return { accessToken, refreshToken };
  }

  async refresh(refreshToken: string, clientInfo?: { ip?: string; userAgent?: string }): Promise<{ accessToken: string; refreshToken: string }> {
    const stored = await this.refreshTokenModel.findOne({ token: refreshToken }).exec();
    if (!stored || stored.expiresAt < new Date()) {
      if (stored) await stored.deleteOne();
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Warn if client context changed (IP or User-Agent mismatch)
    if (stored.ip && clientInfo?.ip && stored.ip !== clientInfo.ip) {
      this.logger.warn(`Refresh token used from different IP: stored=${stored.ip}, current=${clientInfo.ip}, userId=${stored.userId}`);
    }

    // Rotate: delete old, create new
    await stored.deleteOne();

    const user = await this.userModel.findById(stored.userId).exec();
    if (!user || !user.active) {
      throw new UnauthorizedException('User not found or inactive');
    }

    const accessToken = this.generateAccessToken(user);
    const newRefreshToken = await this.generateRefreshToken(user._id.toString(), clientInfo);

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
    const users = await this.userModel.find().select('-passwordHash').sort({ createdAt: -1 }).exec();
    return users.map((u) => this.maskUserSecrets(u));
  }

  async findUserById(id: string): Promise<UserDocument | null> {
    const user = await this.userModel.findById(id).select('-passwordHash').exec();
    return user ? this.maskUserSecrets(user) : null;
  }

  async findByUsername(username: string): Promise<UserDocument | null> {
    const user = await this.userModel
      .findOne({ username })
      .select('-passwordHash')
      .exec();
    return user ? this.maskUserSecrets(user) : null;
  }

  async findActiveUsers(windowMinutes = 15): Promise<ActiveUserSummary[]> {
    const clampedWindowMinutes = Math.min(Math.max(Math.floor(windowMinutes), 1), 120);
    const since = new Date(Date.now() - clampedWindowMinutes * 60 * 1000);
    const now = new Date();

    const tokenRows = await this.refreshTokenModel
      .find({
        expiresAt: { $gt: now },
        updatedAt: { $gte: since },
      })
      .select('userId updatedAt createdAt')
      .sort({ updatedAt: -1 })
      .lean<Array<{ userId: string; updatedAt?: Date; createdAt?: Date }>>()
      .exec();

    const lastSeenByUserId = new Map<string, Date>();
    for (const row of tokenRows) {
      const lastSeenAt = row.updatedAt || row.createdAt;
      if (!row.userId || !lastSeenAt || lastSeenByUserId.has(row.userId)) continue;
      lastSeenByUserId.set(row.userId, lastSeenAt);
    }

    if (lastSeenByUserId.size === 0) return [];

    const users = await this.userModel
      .find({
        _id: { $in: Array.from(lastSeenByUserId.keys()) },
        active: true,
      })
      .select('username role')
      .lean<Array<{ _id: unknown; username: string; role: UserRole }>>()
      .exec();

    return users
      .map((user) => {
        const userId = String(user._id);
        const lastSeenAt = lastSeenByUserId.get(userId);
        if (!lastSeenAt) return null;
        return {
          userId,
          username: user.username,
          role: user.role,
          lastSeenAt,
        };
      })
      .filter((user): user is ActiveUserSummary => user !== null)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  }

  private maskUserSecrets(user: UserDocument): UserDocument {
    if (user?.llmConfig?.apiKey) {
      user.llmConfig.apiKey = API_KEY_MASK;
    }
    return user;
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
    permissions?: string[];
    projectScopeMode?: 'all' | 'allowlist' | 'none';
    allowedProjectIds?: string[];
    customerScopeMode?: 'all' | 'allowlist' | 'none';
    allowedCustomerIds?: string[];
  }): Promise<UserDocument | null> {
    const update: Record<string, unknown> = {};
    if (data.username !== undefined) update.username = data.username;
    if (data.email !== undefined) update.email = data.email;
    if (data.role !== undefined) update.role = data.role;
    if (data.active !== undefined) update.active = data.active;
    if (data.permissions !== undefined) update.permissions = data.permissions;
    if (data.projectScopeMode !== undefined) update.projectScopeMode = data.projectScopeMode;
    if (data.allowedProjectIds !== undefined) update.allowedProjectIds = data.allowedProjectIds;
    if (data.customerScopeMode !== undefined) update.customerScopeMode = data.customerScopeMode;
    if (data.allowedCustomerIds !== undefined) update.allowedCustomerIds = data.allowedCustomerIds;

    // Reject allowlist with empty list — same rationale as in api-keys.service.ts:
    // silently locking a user out of all data on an axis is a footgun.
    if (update.projectScopeMode === 'allowlist'
        && Array.isArray(update.allowedProjectIds)
        && (update.allowedProjectIds as string[]).length === 0) {
      throw new UnauthorizedException(
        'projectScopeMode=allowlist erfordert mindestens eine projectId.',
      );
    }
    if (update.customerScopeMode === 'allowlist'
        && Array.isArray(update.allowedCustomerIds)
        && (update.allowedCustomerIds as string[]).length === 0) {
      throw new UnauthorizedException(
        'customerScopeMode=allowlist erfordert mindestens eine customerId.',
      );
    }

    // Audit-trail (lightweight). Full audit-log module is tracked as T-214 in
    // M-27 and will replace these logger calls once it lands. Until then we
    // emit a structured log so role/scope changes leave a paper trail.
    const securityFields = [
      'role', 'active', 'permissions',
      'projectScopeMode', 'allowedProjectIds',
      'customerScopeMode', 'allowedCustomerIds',
    ];
    const securityChanges: Record<string, unknown> = {};
    for (const f of securityFields) {
      if (f in update) securityChanges[f] = (update as Record<string, unknown>)[f];
    }
    if (Object.keys(securityChanges).length > 0) {
      this.logger.warn(
        `[security-audit] User ${id} security fields changed: ${JSON.stringify(securityChanges)}`,
      );
    }

    return this.userModel
      .findByIdAndUpdate(id, update, { new: true })
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

  async updateProfile(
    userId: string,
    data: { username?: string; email?: string; llmConfig?: LlmConfigDto },
  ): Promise<UserDocument | null> {
    const update: Record<string, unknown> = {};
    if (typeof data.username === 'string') update.username = data.username;
    if (typeof data.email === 'string') update.email = data.email;

    if (data.llmConfig) {
      const existing = await this.userModel.findById(userId).select('llmConfig').exec();
      const current: UserLlmConfig = existing?.llmConfig || {};
      const incoming = data.llmConfig;

      // Resolve the next apiKey value:
      // - undefined or mask placeholder → keep existing (encrypted) value
      // - empty string → clear the key
      // - any other plain value → encrypt before storing (if encryption is configured)
      let nextApiKey = current.apiKey;
      if (incoming.apiKey !== undefined && incoming.apiKey !== API_KEY_MASK) {
        const trimmed = incoming.apiKey;
        if (trimmed === '') {
          nextApiKey = '';
        } else if (this.encryptionService.isEnabled()) {
          nextApiKey = this.encryptionService.encrypt(trimmed);
        } else {
          this.logger.warn(
            `Storing plaintext llmConfig.apiKey for user ${userId} — set SECRETS_ENCRYPTION_KEY to encrypt at rest.`,
          );
          nextApiKey = trimmed;
        }
      }

      update.llmConfig = {
        mode: incoming.mode ?? current.mode,
        endpoint: incoming.endpoint ?? current.endpoint,
        model: incoming.model ?? current.model,
        apiKey: nextApiKey,
        fallbackEnabled: incoming.fallbackEnabled ?? current.fallbackEnabled,
      };
    }

    const updated = await this.userModel
      .findByIdAndUpdate(userId, update, { new: true })
      .select('-passwordHash')
      .exec();
    return updated ? this.maskUserSecrets(updated) : null;
  }

  private generateAccessToken(user: UserDocument): string {
    return this.jwtService.sign(
      { sub: user._id.toString(), username: user.username, role: user.role },
      { expiresIn: ACCESS_TOKEN_EXPIRY },
    );
  }

  private async generateRefreshToken(userId: string, clientInfo?: { ip?: string; userAgent?: string }): Promise<string> {
    const token = randomBytes(48).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    await this.refreshTokenModel.create({
      token,
      userId,
      expiresAt,
      ip: clientInfo?.ip,
      userAgent: clientInfo?.userAgent,
    });

    return token;
  }
}
