import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InjectFlowProducer } from '@nestjs/bullmq';
import { FlowProducer } from 'bullmq';
import { PrismaService } from '../../shared/database/prisma.service';
import { CreatePurchaseDto } from '../dto/create-purchase.dto';

export const PURCHASE_SAGA_QUEUE = 'purchase-saga';

const SAGA_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  failParentOnFailure: true,
};

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectFlowProducer(PURCHASE_SAGA_QUEUE) private readonly flowProducer: FlowProducer,
  ) {}

  async createPurchase(dto: CreatePurchaseDto) {
    // STEP 1 (RESERVE): a conditional update is atomic enough on its own -
    // if two requests race for the same seat, only one UPDATE affects a row.
    const { count } = await this.prisma.seat.updateMany({
      where: { id: dto.seatId, status: 'AVAILABLE' },
      data: { status: 'RESERVED', reservedBy: dto.buyerId },
    });

    if (count === 0) {
      throw new ConflictException(`Seat ${dto.seatId} is not available`);
    }

    const purchase = await this.prisma.purchase.create({
      data: {
        seatId: dto.seatId,
        buyerId: dto.buyerId,
        amount: dto.amount,
        status: 'PENDING',
        currentStep: 'RESERVE',
        externalKey: randomUUID(),
      },
    });

    // STEPS 2-4 (CHARGE, CONFIRM, NOTIFY) run asynchronously as a BullMQ
    // flow. Flow children complete before their parent runs, so nesting
    // them charge -> confirm -> notify guarantees that order, and
    // failParentOnFailure means a failed CHARGE stops CONFIRM/NOTIFY from
    // ever running.
    await this.flowProducer.add({
      name: 'notify',
      queueName: PURCHASE_SAGA_QUEUE,
      data: { purchaseId: purchase.id },
      opts: SAGA_JOB_OPTIONS,
      children: [
        {
          name: 'confirm',
          queueName: PURCHASE_SAGA_QUEUE,
          data: { purchaseId: purchase.id },
          opts: SAGA_JOB_OPTIONS,
          children: [
            {
              name: 'charge',
              queueName: PURCHASE_SAGA_QUEUE,
              data: { purchaseId: purchase.id },
              opts: SAGA_JOB_OPTIONS,
            },
          ],
        },
      ],
    });

    return purchase;
  }

  findOne(id: string) {
    return this.prisma.purchase.findUniqueOrThrow({ where: { id } });
  }
}
