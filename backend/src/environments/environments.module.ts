import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Environment, EnvironmentSchema } from './schemas/environment.schema';
import { EnvironmentsService } from './environments.service';
import { EnvironmentsController } from './environments.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Environment.name, schema: EnvironmentSchema }]),
  ],
  controllers: [EnvironmentsController],
  providers: [EnvironmentsService],
  exports: [EnvironmentsService],
})
export class EnvironmentsModule {}
