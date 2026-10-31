import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { ItemCoordinator } from './coordinator';

const TICK_MS = 5000;

/** Feeds waiting items on a timer too, so nothing waits forever if a trigger was missed. */
@Injectable()
export class FeederTicker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FeederTicker.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly coordinator: ItemCoordinator) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.coordinator.feed().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Feeding waiting items failed');
      });
    }, TICK_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}
