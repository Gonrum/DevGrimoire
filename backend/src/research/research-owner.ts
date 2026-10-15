import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IdLike, ScopeSource } from '../common/actor-scope';
import { User, UserDocument } from '../auth/schemas/user.schema';

export type ResearchOwner = { _id: IdLike; username: string; role: string; active?: boolean } & ScopeSource;

/**
 * Lädt den Besitzer einer Recherche direkt über das User-Modell — nicht über
 * `AuthService`, damit ResearchModule kein AuthModule importiert (Modul-Zyklen;
 * Muster wie in PushModule). Schnittstelle bewusst gleich `AuthService.findUserById`.
 */
@Injectable()
export class ResearchOwnerLookup {
  constructor(@InjectModel(User.name) private readonly users: Model<UserDocument>) {}

  async findUserById(id: string): Promise<ResearchOwner | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.users
      .findById(new Types.ObjectId(id))
      .select('username role active permissions projectScopeMode allowedProjectIds customerScopeMode allowedCustomerIds')
      .lean<ResearchOwner & { _id: Types.ObjectId }>()
      .exec();
  }
}
