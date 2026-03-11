import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DbSchema, DbSchemaSchema } from './schemas/db-schema.schema';
import { SchemaVersion, SchemaVersionSchema } from './schemas/schema-version.schema';
import { SchemasService } from './schemas.service';
import { SchemasController } from './schemas.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DbSchema.name, schema: DbSchemaSchema },
      { name: SchemaVersion.name, schema: SchemaVersionSchema },
    ]),
  ],
  controllers: [SchemasController],
  providers: [SchemasService],
  exports: [SchemasService],
})
export class SchemasModule {}
