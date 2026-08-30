import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { PurchasesService } from '../services/purchases.service';
import { CreatePurchaseDto } from '../dto/create-purchase.dto';

@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchasesService: PurchasesService) {}

  @Post()
  create(@Body() dto: CreatePurchaseDto) {
    return this.purchasesService.createPurchase(dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.purchasesService.findOne(id);
  }
}
