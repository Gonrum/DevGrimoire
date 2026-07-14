import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Stack, StackSchema } from './schemas/stack.schema';
import { StacksService } from './stacks.service';
import { StacksController } from './stacks.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: Stack.name, schema: StackSchema }])],
  controllers: [StacksController],
  providers: [StacksService],
  exports: [StacksService],
})
export class StacksModule {}
