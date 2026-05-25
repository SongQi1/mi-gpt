import { MiGPT } from "./index";
import { buildMiGPTConfig } from "./services/config/db-config";
import { Logger } from "./utils/log";

class MiGPTManager {
  private instances: Map<string, MiGPT> = new Map();
  private logger = Logger.create({ tag: "MiGPTManager" });

  async startAccount(accountId: string): Promise<void> {
    try {
      if (this.instances.has(accountId)) {
        await this.stopAccount(accountId);
      }
      const config = await buildMiGPTConfig(accountId);
      if (!config) {
        this.logger.error(`Account ${accountId}: config not found`);
        return;
      }
      const instance = new MiGPT(accountId, config);
      this.instances.set(accountId, instance);
      instance.start().catch((e) =>
        this.logger.error(`Account ${accountId} start error`, e)
      );
    } catch (e) {
      this.logger.error(`Account ${accountId} init failed, skipped`, e);
      this.instances.delete(accountId);
    }
  }

  async stopAccount(accountId: string): Promise<void> {
    const instance = this.instances.get(accountId);
    if (instance) {
      await instance.stop();
      this.instances.delete(accountId);
      this.logger.log(`Account ${accountId} stopped`);
    }
  }

  async restartAccount(accountId: string): Promise<void> {
    await this.stopAccount(accountId);
    await this.startAccount(accountId);
    this.logger.log(`Account ${accountId} restarted`);
  }

  async startAll(): Promise<void> {
    const { kPrisma } = await import("./services/db");
    const allAccounts = await kPrisma.xiaomiAccount.findMany();
    for (const account of allAccounts) {
      try {
        await this.startAccount(account.id);
      } catch (e) {
        this.logger.error(`Account ${account.id} start failed, continuing`, e);
      }
    }
    this.logger.log(`Started ${this.instances.size} account(s)`);
  }

  async stopAll(): Promise<void> {
    for (const [accountId] of this.instances) {
      await this.stopAccount(accountId);
    }
  }

  getStatus(accountId: string): "running" | "stopped" {
    return this.instances.has(accountId) ? "running" : "stopped";
  }

  getAccountStatus(accountId: string) {
    const instance = this.instances.get(accountId);
    return instance ? instance.getStatus() : { accountId, speakers: [] };
  }

  getAllStatus() {
    const result: Record<string, any> = {};
    for (const [accountId, instance] of this.instances) {
      result[accountId] = instance.getStatus();
    }
    return result;
  }
}

export const manager = new MiGPTManager();
