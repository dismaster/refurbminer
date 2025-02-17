import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { join } from 'path';

@Controller()
export class AppController {
    @Get()
    root(@Res() res: Response) {
        return res.sendFile(join(process.cwd(), 'dist', 'public', 'index.html'));
    }
}