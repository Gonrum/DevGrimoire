import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Setting, SettingDocument } from './schemas/setting.schema';

@Injectable()
export class SettingsService {
  constructor(
    @InjectModel(Setting.name)
    private settingModel: Model<SettingDocument>,
  ) {}

  async get(key: string): Promise<string | null> {
    const setting = await this.settingModel.findOne({ key }).exec();
    return setting?.value ?? null;
  }

  async getOrDefault(key: string, defaultValue: string): Promise<string> {
    const setting = await this.settingModel.findOne({ key }).exec();
    if (setting) return setting.value;
    await this.settingModel.create({ key, value: defaultValue });
    return defaultValue;
  }

  async set(key: string, value: string): Promise<SettingDocument> {
    return this.settingModel.findOneAndUpdate(
      { key },
      { value },
      { new: true, upsert: true },
    ).exec() as Promise<SettingDocument>;
  }
}
