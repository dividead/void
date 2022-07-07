import { Context, Telegraf } from "telegraf";
import { MessageEntity } from "telegraf/typings/telegram-types";
import { Driver, MetadataAuthService, TypedData, Ydb } from "ydb-sdk";
import { v4 } from "uuid";

type ResultSet = Ydb.IResultSet[];

// type Extra = {
//   id: string;
//   type: string;
//   file_id?: string;
//   text?: string;
// };

// type LogEntry = {
//   id: string; // uuid v4
//   chat_id: number;
//   user_id: number;
//   extra: string;
//   ts: number; // unix
// };

let db: Driver;

const init_db = async () => {
  db = new Driver({
    endpoint: process.env.ENDPOINT,
    database: process.env.DATABASE,
    authService: new MetadataAuthService(),
  });
  const timeout = 10000;
  if (!(await db.ready(timeout))) {
    console.error(`Driver has not become ready in ${timeout}ms!`);
    // process.exit(1);
  }
  // console.log('Driver ready');
};

const sendStats = async (
  chat_id: number,
  user_id: number,
  key: string,
  username?: string
) => {
  if (!username) return;
  const query = `insert into extras_logs (id, chat_id, user_id, username, extra, ts) 
  values ('${v4()}', ${chat_id}, ${user_id}, '${username}', '${key}', ${Date.now()});`;
  await db?.tableClient.withSession(async (session) => {
    await session.executeQuery(query);
  });
};

const getStats = async (
  cb: (rs: ResultSet) => void,
  chat_id: number,
  key: string
) => {
  const query = `select username, count(username) as count from extras_logs 
  where chat_id=${chat_id} and extra='${key}'
  group by username
  order by count desc;`;

  await db?.tableClient.withSession(async (session) => {
    const { resultSets } = await session.executeQuery(query);

    cb(resultSets);
  });
};

const insert = async (
  chat_id: number,
  type: string,
  key: string,
  file_id?: string,
  text?: string
) => {
  let query = "";
  let id = `${chat_id}:${key}`;

  if (type === "text") {
    query = `insert into extras (id, type, text)
          values ('${id}', 'text', '${text}');`;
  } else {
    query = `insert into extras (id, type, file_id)
          values ('${id}', '${type}', '${file_id}');`;
  }

  await db?.tableClient.withSession(async (session) => {
    await session.executeQuery(query);
  });
};

const fetch = async (
  cb: (rs: ResultSet) => void,
  chat_id: number,
  user_id: number,
  key: string,
  username?: string
) => {
  const query = `
    select (type, file_id, text)
    from extras 
    where id='${chat_id}:${key}'
    limit 1;`;

  await db?.tableClient.withSession(async (session) => {
    const { resultSets } = await session.executeQuery(query);

    cb(resultSets);

    sendStats(chat_id, user_id, key, username).catch(console.error);
  });
};

const remove = async (chat_id: number, key: string) => {
  const query = `delete from extras where id='${chat_id}:${key}';`;

  await db?.tableClient.withSession(async (session) => {
    await session.executeQuery(query);
  });
};

const findTag = (ctx: Context) => {
  if (!ctx.message) return;
  const { entities, caption_entities } = ctx.message;
  const inText = entities?.find((e) => e.type === "hashtag");
  if (inText) return inText;
  return caption_entities?.find((e) => e.type === "hashtag");
};

const getKey = (text: string, tag: MessageEntity) =>
  text.substring(tag.offset + 1, tag.offset + tag.length);

const findKey = (ctx: Context) => {
  if (!ctx.message) return;
  const tag = findTag(ctx);
  if (!tag) return;
  const { text, caption } = ctx.message;
  return getKey(text || (caption as string), tag);
};

const replyTo = (ctx: Context) => {
  if (!ctx.message) return {};
  return {
    reply_to_message_id: ctx.message.message_id,
  };
};

const sendSticker = (ctx: Context, t: string) => {
  const m: Record<string, string> = {
    note: "CAACAgIAAxkBAAKRVWK4zq02vcEv68HmJPzIR81TOsmaAAIsAAO0TOooIXA4G0AKaaYpBA",
    nope: "CAACAgIAAxkBAAMPYlwY4KwunC0WMuXIs9QnL6FrW9oAAhsAA7RM6iiFfQTU2-0gbyQE",
    ok: "CAACAgIAAxkBAAKT6GK61eW-uS2oGz7SEEzg3IUYoYo2AAIRAAO0TOoo0MgUmCOShB0pBA",
  };

  ctx.replyWithSticker(m[t], replyTo(ctx));
};

const bot = new Telegraf(process.env.BOT_TOKEN!);

bot.start((ctx) =>
  ctx.reply(`Together we can bestow upon our people the fortune they so richly deserve...
Extinction.`)
);

bot.help((ctx) =>
  ctx.reply(`I told you never to go there.
Are you not devoted to me?`)
);

bot.command("extra", async (ctx) => {
  if (!ctx.message) return;
  // console.log("extra", JSON.stringify(ctx.message));
  const { reply_to_message, chat } = ctx.message;
  if (!reply_to_message) return;
  try {
    const key = findKey(ctx);
    if (!key) return;
    // @ts-ignore TODO: untyped
    const { photo, animation, video, text, sticker, voice } = reply_to_message;
    if (photo) {
      await insert(chat.id, "photo", key, photo[0].file_id);
    } else if (animation) {
      await insert(chat.id, "animation", key, animation.file_id);
    } else if (video) {
      await insert(chat.id, "video", key, video.file_id);
    } else if (text) {
      await insert(chat.id, "text", key, undefined, text);
    } else if (sticker) {
      await insert(chat.id, "sticker", key, sticker.file_id);
    } else if (voice) {
      await insert(chat.id, "voice", key, voice.file_id);
    }

    sendSticker(ctx, "note");
  } catch (e) {
    console.error(e);
    sendSticker(ctx, "nope");
  }
});

bot.command("extradel", async (ctx) => {
  if (!ctx.message) return;
  const { chat } = ctx.message;
  try {
    const key = findKey(ctx);
    if (!key) return;
    await remove(chat.id, key);
    sendSticker(ctx, "ok");
  } catch (e) {
    console.error(e);
    sendSticker(ctx, "nope");
  }
});

bot.command("extrastat", async (ctx) => {
  if (!ctx.message) return;
  const { chat } = ctx.message;
  try {
    const key = findKey(ctx);
    if (!key) return;
    const cb = (rs: ResultSet) => {
      if (!rs) return;
      const rows = TypedData.createNativeObjects(rs[0]);
      if (!rows.length) return ctx.reply("🤔", replyTo(ctx));
      const data = rows
        .map(({ username, count }) => [username, count].join(": "))
        .join("\n");
      return ctx.reply(data, replyTo(ctx));
    };
    getStats(cb, chat.id, key);
  } catch (e) {
    console.error(e);
    sendSticker(ctx, "nope");
  }
});

bot.on("message", async (ctx) => {
  if (!ctx.message) return;
  // console.log("message", JSON.stringify(ctx.message));
  const { chat, from } = ctx.message;
  const key = findKey(ctx);
  if (!key) return;
  const cb = (rs: ResultSet) => {
    if (!rs) return;
    const extra = replyTo(ctx);
    const [row] = TypedData.createNativeObjects(rs[0]);
    if (!row) return;
    const {
      column0: [type, file_id, txt],
    } = row;
    switch (type) {
      case "photo":
        return ctx.replyWithPhoto(file_id, extra);
      case "animation":
        return ctx.replyWithVideo(file_id, extra);
      case "video":
        return ctx.replyWithVideo(file_id, extra);
      case "sticker":
        return ctx.replyWithSticker(file_id, extra);
      case "voice":
        return ctx.replyWithVoice(file_id, extra);
      case "text":
        return ctx.reply(txt, extra);
      default:
        break;
    }
  };
  fetch(cb, chat.id, from?.id as number, key, from?.username);
});

export const handler = async (event: { body: string }, _: Context) => {
  await init_db();
  const message = JSON.parse(event.body);
  await bot.handleUpdate(message);
  return {
    statusCode: 200,
    body: "",
  };
};
