import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Project, ProjectDocument } from '../projects/schemas/project.schema';
import { Customer, CustomerDocument } from '../customers/schemas/customer.schema';

async function exists(model: Model<ProjectDocument> | Model<CustomerDocument>, id: string, label: string): Promise<void> {
  if (!Types.ObjectId.isValid(id)) throw new NotFoundException(`${label} nicht gefunden`);
  const found = await model.exists({ _id: new Types.ObjectId(id) }).exec();
  if (!found) throw new NotFoundException(`${label} nicht gefunden`);
}

/**
 * Existenzprüfung für „Verschieben“ direkt über das Modell: ProjectsModule
 * importiert ResearchModule, ProjectsService wäre ein Modul-Zyklus.
 */
@Injectable()
export class ResearchProjectLookup {
  constructor(@InjectModel(Project.name) private readonly model: Model<ProjectDocument>) {}
  async findById(id: string): Promise<void> { await exists(this.model, id, 'Projekt'); }
}

@Injectable()
export class ResearchCustomerLookup {
  constructor(@InjectModel(Customer.name) private readonly model: Model<CustomerDocument>) {}
  async findById(id: string): Promise<void> { await exists(this.model, id, 'Kunde'); }
}
