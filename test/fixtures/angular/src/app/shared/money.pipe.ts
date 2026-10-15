import { Pipe, PipeTransform } from "@angular/core";

@Pipe({ name: "money" })
export class MoneyPipe implements PipeTransform {
    transform(value: number, currency: string): string {
        return `${value} ${currency}`;
    }
}
