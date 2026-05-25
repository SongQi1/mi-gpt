import { AISpeaker, AISpeakerConfig } from "./services/speaker/ai";
import { MyBot, MyBotConfig } from "./services/bot";
import { initDB, runWithDB } from "./services/db";
import { kBannerASCII } from "./utils/string";
import { Logger } from "./utils/log";

export { initDB, runWithDB, kPrisma } from "./services/db";
export {
  validateAuthToken,
  createAuthToken,
  registerWebUser,
  loginWebUser,
  deleteWebUser,
  getAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  getAccount,
  createSpeaker,
  updateSpeaker,
  deleteSpeaker,
  getSpeakers,
  migrateFromFile,
} from "./services/config/db-config";
export { manager } from "./manager";
export { LoggerManager } from "./utils/log";

export type MiGPTSpeakerConfig = Omit<AISpeakerConfig, "askAI"> & {
  id?: string;
  bot?: MyBotConfig["bot"];
  master?: MyBotConfig["master"];
  room?: MyBotConfig["room"];
  systemTemplate?: string;
  username?: string;
  passToken?: string;
};

export type MiGPTConfig = Omit<MyBotConfig, "speaker" | "botConfigPath"> & {
  username?: string;
  speaker: Omit<AISpeakerConfig, "askAI"> & { passToken?: string };
  speakers?: MiGPTSpeakerConfig[];
};

type MiGPTRuntimeConfig = {
  id: string;
  speaker: AISpeakerConfig;
  bot: Omit<MyBotConfig, "speaker">;
};

export class MiGPT {
  accountId: string;
  username?: string;
  logger: ReturnType<typeof Logger.create>;
  ai: MyBot;
  speaker: AISpeaker;
  bots: MyBot[];
  speakers: AISpeaker[];
  private static _initLock = Promise.resolve();

  constructor(accountId: string, config: MiGPTConfig) {
    this.accountId = accountId;
    this.username = config.username;
    this.logger = Logger.create({
      tag: config.username ? `MiGPT[${config.username}]` : "MiGPT",
      username: config.username,
    });
    const configs = MiGPT.normalizeConfigs(config, accountId);
    this.speakers = configs.map((e) => new AISpeaker(e.speaker));
    this.bots = configs.map(
      (e, index) => new MyBot({ ...e.bot, speaker: this.speakers[index] })
    );
    this.speaker = this.speakers[0];
    this.ai = this.bots[0];
  }

  private static normalizeConfigs(config: MiGPTConfig, accountId?: string): MiGPTRuntimeConfig[] {
    const { speaker, speakers, username, ...botConfig } = config;
    const hasAccount = speaker?.userId && (speaker?.password || speaker?.passToken);
    const logger = Logger.create({ tag: "MiGPT" });
    logger.assert(hasAccount, "Missing userId, and password or passToken.");
    if (!speakers?.length) {
      const speakerPassword = speaker.password || (speaker.passToken ? "passToken" : "");
      return [
        {
          id: "default",
          speaker: { ...speaker, password: speakerPassword, xiaomiAccountId: accountId, username },
          bot: botConfig,
        },
      ];
    }
    const ids = new Set<string>();
    const dids = new Set<string>();
    // 提示：speakers 模式下，顶层 speaker.did 会被每一项覆盖，建议只在单音箱模式下使用
    if (speaker.did) {
      logger.log(
        "💡 建议：多音箱模式下，顶层 speaker.did 会被每一项覆盖。" +
          "请在 speakers[] 中单独配置每台设备的 did。"
      );
    }
    return speakers.map((item, index) => {
      const id = MiGPT.getSpeakerId(item, index);
      logger.assert(!ids.has(id), `Duplicate speaker id: ${id}`);
      ids.add(id);
      const { id: _id, bot, master, room, systemTemplate, ...speakerConfig } = item;
      // mi-service-lite 要求 password 必须非空，仅用 passToken 时填占位值
      const speakerPassword = speaker.password || (speaker.passToken ? "passToken" : "");
      const currentSpeaker = { ...speaker, ...speakerConfig, password: speakerPassword, xiaomiAccountId: accountId, username };
      const did = currentSpeaker.did!;
      logger.assert(did, `Missing did for speaker: ${id}`);
      logger.assert(!dids.has(did), `Duplicate speaker did: ${did}`);
      dids.add(did);
      return {
        id,
        speaker: currentSpeaker,
        bot: {
          ...botConfig,
          bot: bot ?? botConfig.bot,
          master: master ?? botConfig.master,
          room: room ?? botConfig.room,
          systemTemplate: systemTemplate || botConfig.systemTemplate || undefined,
          botConfigPath: id,
        },
      };
    });
  }

  private static getSpeakerId(config: MiGPTSpeakerConfig, index: number) {
    const source = config.id || config.did || `${index + 1}`;
    return source.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  async start() {
    await initDB(this.speakers.some((speaker) => speaker.debug));
    const main = async () => {
      console.log(kBannerASCII);
      // 多账号场景下，.mi.json 操作需要串行化，避免并发读写冲突
      const prev = MiGPT._initLock;
      let release: () => void;
      MiGPT._initLock = new Promise<void>((resolve) => { release = resolve; });
      await prev;
      try {
        // 首次加载账号专属的 .mi.json（含持久化 token，避免每次 init 都重新登录）
        await this.speakers[0].loadAccountFile();
        for (const speaker of this.speakers) {
          await speaker.initMiServices();
          // 持久化最新 token（清除 device 缓存），后续 speaker 复用
          await speaker.saveAccountFile();
        }
      } finally {
        release!();
      }
      await Promise.all(this.bots.map((bot) => bot.run()));
    };
    return runWithDB(async () => {
      try {
        await main();
      } catch (e) {
        this.logger.error(`Account ${this.accountId} start error`, e);
      }
    });
  }

  async stop() {
    await Promise.all(this.bots.map((bot) => bot.stop()));
  }

  getStatus() {
    return {
      accountId: this.accountId,
      speakers: this.speakers.map((s) => s.getStatus()),
    };
  }
}
