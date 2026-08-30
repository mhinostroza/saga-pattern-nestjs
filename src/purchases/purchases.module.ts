import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PurchasesController } from './controllers/purchases.controller';
import { PurchasesService, PURCHASE_SAGA_QUEUE } from './services/purchases.service';
import { PurchaseSagaService } from './services/purchase-saga.service';
import { PurchaseSagaProcessor } from './services/purchase-saga.processor';
import { StripeModule } from '../shared/external-services/stripe/stripe.module';

@Module({
  imports: [
    StripeModule,
    BullModule.registerQueue({ name: PURCHASE_SAGA_QUEUE }),
    BullModule.registerFlowProducer({ name: PURCHASE_SAGA_QUEUE }),
  ],
  controllers: [PurchasesController],
  providers: [PurchasesService, PurchaseSagaService, PurchaseSagaProcessor],
})
export class PurchasesModule {}
