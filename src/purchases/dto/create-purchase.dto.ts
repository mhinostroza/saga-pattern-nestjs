import { IsNumber, IsPositive, IsString, IsUUID } from 'class-validator';

export class CreatePurchaseDto {
  @IsUUID()
  seatId: string;

  @IsString()
  buyerId: string;

  @IsNumber()
  @IsPositive()
  amount: number;
}
