import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { DbSchema, DbSchemaDocument } from './schemas/db-schema.schema';
import { SchemaVersion, SchemaVersionDocument } from './schemas/schema-version.schema';
import { CreateSchemaDto } from './dto/create-schema.dto';
import { UpdateSchemaDto } from './dto/update-schema.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { assertSafeCascadeId } from '../common/cascade-guard';
import { assertOwnerInScope, assertProjectInScope } from '../common/scope-guard';

@Injectable()
export class SchemasService {
  constructor(
    @InjectModel(DbSchema.name)
    private dbSchemaModel: Model<DbSchemaDocument>,
    @InjectModel(SchemaVersion.name)
    private schemaVersionModel: Model<SchemaVersionDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateSchemaDto): Promise<DbSchemaDocument> {
    // A narrowed actor must not document schemas in a foreign project.
    assertProjectInScope(dto.projectId);
    const entry = await this.dbSchemaModel.create({ ...dto, version: 1 });
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry.projectId.toString(),
      entity: 'schema',
      action: 'created',
      entityId: entry._id.toString(),
      summary: `Schema "${entry.name}" (${entry.dbType}) erstellt`,
    });
    return entry;
  }

  async findByProject(
    projectId: string,
    dbType?: string,
    tags?: string[],
  ): Promise<DbSchemaDocument[]> {
    assertProjectInScope(projectId);
    const filter: Record<string, unknown> = { projectId: projectIdFilter(projectId) };
    if (dbType) filter.dbType = dbType;
    if (tags?.length) filter.tags = { $all: tags };
    return this.dbSchemaModel.find(filter).sort({ name: 1 }).exec();
  }

  /** Load + 404 + scope check — every by-id path (incl. versions) goes through here. */
  private async findScoped(id: string): Promise<DbSchemaDocument> {
    const entry = await this.dbSchemaModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Schema ${id} not found`);
    assertOwnerInScope({ projectId: entry.projectId }, `Schema ${id}`);
    return entry;
  }

  async findById(id: string): Promise<DbSchemaDocument> {
    return this.findScoped(id);
  }

  async update(id: string, dto: UpdateSchemaDto): Promise<DbSchemaDocument> {
    // Scope check before the update AND before the version snapshot is written.
    const current = await this.findScoped(id);

    // Apply updates first, then snapshot with changeNote
    const { changeNote, ...updateData } = dto;
    const entry = await this.dbSchemaModel
      .findByIdAndUpdate(
        id,
        { ...updateData, $inc: { version: 1 } },
        { new: true },
      )
      .exec();

    // Snapshot the new state as a version with the changeNote
    await this.schemaVersionModel.create({
      schemaId: current._id,
      version: entry!.version,
      fields: entry!.fields,
      indexes: entry!.indexes,
      changeNote,
    });

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry!.projectId.toString(),
      entity: 'schema',
      action: 'updated',
      entityId: id,
      summary: `Schema "${entry!.name}" aktualisiert (v${entry!.version})${changeNote ? ': ' + changeNote : ''}`,
    });
    return entry!;
  }

  async remove(id: string): Promise<void> {
    // Checked before the delete — the cascade would wipe a foreign history too.
    const current = await this.findScoped(id);
    const result = await this.dbSchemaModel.findByIdAndDelete(current._id).exec();
    if (!result) throw new NotFoundException(`Schema ${id} not found`);
    // Cascade delete all versions
    await this.schemaVersionModel.deleteMany({ schemaId: current._id }).exec();
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId.toString(),
      entity: 'schema',
      action: 'deleted',
      entityId: id,
      summary: `Schema "${result.name}" gelöscht`,
    });
  }

  async getVersions(schemaId: string): Promise<SchemaVersionDocument[]> {
    // Versions carry no owner themselves — the parent schema decides the scope.
    // Filtering by the loaded _id also keeps the raw param out of the query.
    const parent = await this.findScoped(schemaId);
    return this.schemaVersionModel
      .find({ schemaId: parent._id })
      .sort({ version: -1 })
      .exec();
  }

  async getVersion(
    schemaId: string,
    version: number,
  ): Promise<SchemaVersionDocument> {
    const parent = await this.findScoped(schemaId);
    const entry = await this.schemaVersionModel
      .findOne({ schemaId: parent._id, version })
      .exec();
    if (!entry)
      throw new NotFoundException(
        `Version ${version} for schema ${schemaId} not found`,
      );
    return entry;
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    const schemas = await this.dbSchemaModel.find({ projectId }).exec();
    const schemaIds = schemas.map((s) => s._id);
    await this.schemaVersionModel.deleteMany({ schemaId: { $in: schemaIds } }).exec();
    await this.dbSchemaModel.deleteMany({ projectId }).exec();
  }
}
