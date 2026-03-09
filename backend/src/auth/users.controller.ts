import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { Roles } from './decorators/roles.decorator';
import { RolesGuard } from './guards/roles.guard';
import { UserRole } from './schemas/user.schema';

@Controller('users')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class UsersController {
  constructor(private authService: AuthService) {}

  @Get()
  findAll() {
    return this.authService.findAllUsers();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const user = await this.authService.findUserById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: { username: string; email?: string; password: string; role?: UserRole }) {
    return this.authService.createUser(body);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: { username?: string; email?: string; role?: UserRole; active?: boolean },
  ) {
    const user = await this.authService.updateUser(id, body);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string) {
    const deleted = await this.authService.deleteUser(id);
    if (!deleted) throw new NotFoundException('User not found');
  }
}
