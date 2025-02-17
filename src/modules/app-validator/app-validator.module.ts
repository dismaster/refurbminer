import { Module } from '@nestjs/common';
import { AppValidatorService } from './app-validator.service';

@Module({
  providers: [AppValidatorService]
})
export class AppValidatorModule {}
