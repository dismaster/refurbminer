import { Test, TestingModule } from '@nestjs/testing';
import { AppValidatorService } from './app-validator.service';

describe('AppValidatorService', () => {
  let service: AppValidatorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AppValidatorService],
    }).compile();

    service = module.get<AppValidatorService>(AppValidatorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
