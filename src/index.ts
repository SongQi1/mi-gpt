import { AISpeaker, AISpeakerConfig } from "./services/speaker/ai";
import { MyBot, MyBotConfig } from "./services/bot";
import { getDBInfo, initDB, runWithDB } from "./services/db";
import { kBannerASCII } from "./utils/string";
import { Logger } from "./utils/log";
import { deleteBotIndexFiles, deleteFile } from "./utils/io";

export type MiGPTSpeakerConfig = Omit<AISpeakerConfig, "askAI"> & {
  id?: string;
  bot?: MyBotConfig["bot"];
  master?: MyBotConfig["master"];
  room?: MyBotConfig["room"];
  systemTemplate?: string;
};

export type MiGPTConfig = Omit<MyBotConfig, "speaker" | "botConfigPath"> & {
  speaker: Omit<AISpeakerConfig, "askAI">;
  speakers?: MiGPTSpeakerConfig[];
};

type MiGPTRuntimeConfig = {
  id: string;
  speaker: AISpeakerConfig;
  bot: Omit<MyBotConfig, "speaker">;
};

export class MiGPT {
  static instance: MiGPT | null;
  static async reset() {
    MiGPT.instance = null;
    const { dbPath } = getDBInfo();
    deleteFile(dbPath);
    deleteFile(".mi.json");
    await deleteBotIndexFiles();
    MiGPT.logger.log("MiGPT 已重置，请使用 MiGPT.create() 重新创建实例。");
  }
  static logger = Logger.create({ tag: "MiGPT" });
  static create(config: MiGPTConfig) {
    if (MiGPT.instance) {
      MiGPT.logger.log("🚨 注意：MiGPT 是单例，同一进程只会返回已创建的实例。");
      MiGPT.logger.log(
        "如果需要切换设备或账号，请先使用 MiGPT.reset() 重置实例。"
      );
    } else {
      MiGPT.instance = new MiGPT({ ...config, fromCreate: true });
    }
    return MiGPT.instance;
  }

  ai: MyBot;
  speaker: AISpeaker;
  bots: MyBot[];
  speakers: AISpeaker[];
  constructor(config: MiGPTConfig & { fromCreate?: boolean }) {
    MiGPT.logger.assert(
      config.fromCreate,
      "请使用 MiGPT.create() 获取客户端实例！"
    );
    const configs = MiGPT.normalizeConfigs(config);
    this.speakers = configs.map((e) => new AISpeaker(e.speaker));
    this.bots = configs.map(
      (e, index) => new MyBot({ ...e.bot, speaker: this.speakers[index] })
    );
    this.speaker = this.speakers[0];
    this.ai = this.bots[0];
  }

  private static normalizeConfigs(config: MiGPTConfig): MiGPTRuntimeConfig[] {
    const { speaker, speakers, ...botConfig } = config;
    const hasAccount = speaker?.userId && speaker?.password;
    MiGPT.logger.assert(hasAccount, "Missing userId or password.");
    if (!speakers?.length) {
      return [
        {
          id: "default",
          speaker,
          bot: botConfig,
        },
      ];
    }
    const ids = new Set<string>();
    const dids = new Set<string>();
    // 提示：speakers 模式下，顶层 speaker.did 会被每一项覆盖，建议只在单音箱模式下使用
    if (speaker.did) {
      MiGPT.logger.log(
        "💡 建议：多音箱模式下，顶层 speaker.did 会被每一项覆盖。" +
          "请在 speakers[] 中单独配置每台设备的 did。"
      );
    }
    return speakers.map((item, index) => {
      const id = MiGPT.getSpeakerId(item, index);
      MiGPT.logger.assert(!ids.has(id), `Duplicate speaker id: ${id}`);
      ids.add(id);
      const { id: _id, bot, master, room, systemTemplate, ...speakerConfig } = item;
      const currentSpeaker = { ...speaker, ...speakerConfig };
      const did = currentSpeaker.did!;
      MiGPT.logger.assert(did, `Missing did for speaker: ${id}`);
      MiGPT.logger.assert(!dids.has(did), `Duplicate speaker did: ${did}`);
      dids.add(did);
      return {
        id,
        speaker: currentSpeaker,
        bot: {
          ...botConfig,
          bot: bot ?? botConfig.bot,
          master: master ?? botConfig.master,
          room: room ?? botConfig.room,
          systemTemplate: systemTemplate ?? botConfig.systemTemplate,
          botConfigPath: `.bot.${id}.json`,
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
      for (const speaker of this.speakers) {
        await speaker.initMiServices();
      }
      await Promise.all(this.bots.map((bot) => bot.run()));
    };
    return runWithDB(main);
  }

  async stop() {
    await Promise.all(this.bots.map((bot) => bot.stop()));
  }
}
