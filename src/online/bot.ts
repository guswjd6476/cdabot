// 온라인 방 업무 (특전대·인터뷰와 별개, 조직 없이 방 단위. 방 등록은 시스템 관리자)
//   /중복확인 방등록 — 같은 인스타 아이디가 다시 올라오면 바로 알림, 매일 23:50 올린 사람별 건수
//   /취합 방등록     — '#주제 #지역 내용' 메시지를 주제별·지역별로 모아 /취합 으로 보여줌
import crypto from 'crypto';
import { Telegraf } from 'telegraf';
import { isSysadmin } from '../core/engine';
import { query } from '../db';
import { escapeHtml as e, getErrorMessage, nowKst, parseFlexibleDate, replyLong } from '../utils';

type Kind = 'dup' | 'tally';
type Ctx = any;
const today = () => nowKst().format('YYYY-MM-DD');
const md = (d: string) => `${Number(d.slice(5, 7))}.${Number(d.slice(8, 10))}`;

export const REGIONS = ['도봉', '성북', '노원', '중랑', '강북', '대학', '새신자', '이음'];
const NOT_PROFILE = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'tv', 'accounts', 's']);

/* ====================== 파싱 ====================== */

// 인스타 아이디: instagram.com/아이디 링크, 또는 '아이디/이름/…' 줄의 첫 칸 (영문이 있어야 함 — 날짜 10/8/… 오인 방지)
export function parseInstaIds(text: string): string[] {
    const ids = new Set<string>();
    for (const m of text.matchAll(/instagram\.com\/([A-Za-z0-9._]{1,30})/gi)) if (!NOT_PROFILE.has(m[1].toLowerCase())) ids.add(m[1].toLowerCase());
    for (const m of text.matchAll(/^\s*@?([A-Za-z0-9._]{2,30})\s*\/[^/\n]*\//gm)) if (/[a-z]/i.test(m[1])) ids.add(m[1].toLowerCase());
    return [...ids];
}

// '#주제 #도봉 내용' → 주제(지역이 아닌 첫 태그) + 지역(목록에 있는 첫 태그, 끝의 '구'는 무시) + 두 태그를 뺀 나머지 내용. 둘 중 하나라도 없으면 null
export type Tally = { topic: string; region: string; content: string };
export function parseTally(text: string): Tally | null {
    const tags = [...text.matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
    const isRegion = (t: string) => REGIONS.includes(t.replace(/구$/, ''));
    const regionTag = tags.find(isRegion);
    const topic = tags.find((t) => !isRegion(t));
    if (!regionTag || !topic) return null;
    const content = text.replace(`#${topic}`, '').replace(`#${regionTag}`, '').replace(/\s+/g, ' ').trim();
    return { topic, region: regionTag.replace(/구$/, ''), content };
}

/* ====================== 방 ====================== */

// 방 목록은 메모리에 (모든 단체방 메시지마다 DB를 깨우지 않도록). 방 ID가 바뀌면 다시 읽음
// relay 도 키에 넣음 — 시다봇·카운셀링 봇이 같은 방에 같이 있어도 등록한 쪽만 처리 (두 번 저장 방지)
let rooms: Promise<Set<string>> | null = null;
const roomKey = (chatId: number | string, kind: Kind, relay: boolean) => `${chatId}:${kind}:${relay}`;
async function isRoom(chatId: number, kind: Kind, relay: boolean) {
    rooms ??= query(`SELECT chat_id::text AS id, kind, relay FROM cdabot_rooms;`).then((r) => new Set(r.rows.map((x) => roomKey(x.id, x.kind, x.relay))));
    return (await rooms.catch(() => ((rooms = null), new Set<string>()))).has(roomKey(chatId, kind, relay));
}
async function setRoom(chatId: number, kind: Kind, on: boolean, title: string | undefined, relay: boolean) {
    if (on)
        await query(`INSERT INTO cdabot_rooms (chat_id, kind, title, relay) VALUES ($1, $2, $3, $4) ON CONFLICT (chat_id, kind) DO UPDATE SET title = EXCLUDED.title, relay = EXCLUDED.relay;`, [
            String(chatId), kind, title || null, relay,
        ]);
    else await query(`DELETE FROM cdabot_rooms WHERE chat_id = $1 AND kind = $2;`, [String(chatId), kind]);
    rooms = null;
}

/* ====================== 중복확인 ====================== */

async function saveInsta(ctx: Ctx, ids: string[]) {
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || String(ctx.from.id);
    const dups: string[] = [];
    for (const id of ids) {
        const prev = (
            await query(
                `SELECT poster_name, to_char(posted_date, 'YYYY-MM-DD') AS date, count(*) OVER () AS n FROM cdabot_insta_posts
                 WHERE chat_id = $1 AND insta_id = $2 ORDER BY id LIMIT 1;`,
                [String(ctx.chat.id), id]
            )
        ).rows[0];
        await query(`INSERT INTO cdabot_insta_posts (chat_id, insta_id, poster_tg, poster_name, posted_date, dup) VALUES ($1, $2, $3, $4, $5, $6);`, [
            String(ctx.chat.id), id, ctx.from.id, name, today(), !!prev,
        ]);
        if (prev) dups.push(`• <b>${e(id)}</b> — 처음: ${e(prev.poster_name)} (${md(prev.date)})${Number(prev.n) > 1 ? ` · 이미 ${prev.n}번 올라옴` : ''}`);
    }
    if (dups.length) await ctx.reply(`🚨 <b>중복 인스타</b>\n${dups.join('\n')}`, { parse_mode: 'HTML' });
    else await ctx.react('👍').catch(() => {});
}

// 올린 사람별: 오늘 건수 · 전체 건수 (중복은 건수에서 빼고 따로 표시)
async function instaReport(chatId: number | string, date = today()): Promise<string> {
    const rows = (
        await query(
            `SELECT (array_agg(poster_name ORDER BY id DESC))[1] AS name,
                    count(*) FILTER (WHERE NOT dup) AS total,
                    count(*) FILTER (WHERE NOT dup AND posted_date = $2) AS today,
                    count(*) FILTER (WHERE dup AND posted_date = $2) AS dup_today
             FROM cdabot_insta_posts WHERE chat_id = $1 AND posted_date <= $2
             GROUP BY poster_tg ORDER BY today DESC, total DESC, name;`,
            [String(chatId), date]
        )
    ).rows.map((r) => ({ name: r.name as string, total: Number(r.total), today: Number(r.today), dup: Number(r.dup_today) }));
    const sum = (k: 'today' | 'dup') => rows.reduce((s, r) => s + r[k], 0);
    const lines = rows.map((r) => `• ${e(r.name)}: 오늘 ${r.today}건 · 전체 ${r.total}건${r.dup ? ` (오늘 중복 ${r.dup})` : ''}`);
    return `📊 <b>${md(date)} 인스타 발굴 현황</b>\n${lines.join('\n') || '아직 올라온 건이 없습니다.'}\n\n오늘 합계 ${sum('today')}건${sum('dup') ? ` · 중복 ${sum('dup')}건` : ''}`;
}

// 매일 23:50 (bot.ts 스케줄) — 중복확인 방마다 오늘 현황 (중복확인은 시다봇이 직접 있는 방만)
export async function sendDailyInstaReports(telegram: any) {
    const chats = (await query(`SELECT chat_id::text AS id FROM cdabot_rooms WHERE kind = 'dup' AND NOT relay;`)).rows.map((r) => r.id);
    for (const id of chats) {
        await telegram.sendMessage(id, await instaReport(id), { parse_mode: 'HTML' }).catch((err: unknown) => console.error(`[인스타 현황 전송 실패] ${id}:`, getErrorMessage(err)));
    }
}

/* ====================== 취합 ====================== */

async function saveTally(ctx: Ctx, t: Tally) {
    await query(`INSERT INTO cdabot_tally_posts (chat_id, topic, region, content, poster_tg, posted_date) VALUES ($1, $2, $3, $4, $5, $6);`, [
        String(ctx.chat.id), t.topic, t.region, t.content, ctx.from.id, today(),
    ]);
    await ctx.react('👍').catch(() => {});
}

// 그날 올라온 주제마다 지역 순서대로 내용 (안 올린 지역은 '-'). topic 을 주면 그 주제만
async function tallyReport(chatId: number, date: string, topic?: string): Promise<string> {
    const rows = (
        await query(`SELECT topic, region, content FROM cdabot_tally_posts WHERE chat_id = $1 AND posted_date = $2 AND ($3::text IS NULL OR topic = $3) ORDER BY id;`, [
            String(chatId), date, topic ?? null,
        ])
    ).rows as Tally[];
    const topics = [...new Set(rows.map((r) => r.topic))];
    if (!topics.length) return `📋 ${md(date)} ${topic ? `#${e(topic)} ` : ''}취합할 내용이 없습니다.`;
    const blocks = topics.map((tp) => {
        const xs = rows.filter((r) => r.topic === tp);
        const lines = REGIONS.map((reg) => `• ${reg}: ${xs.filter((r) => r.region === reg).map((r) => e(r.content) || '(내용 없음)').join(' / ') || '-'}`);
        return `<b>#${e(tp)}</b> (${new Set(xs.map((r) => r.region)).size}/${REGIONS.length} 지역)\n${lines.join('\n')}`;
    });
    return `📋 <b>${md(date)} 취합</b>\n\n${blocks.join('\n\n')}`;
}

/* ====================== 명령·메시지 ====================== */

const KIND_OF: Record<string, Kind> = { 중복확인: 'dup', 취합: 'tally' };
const REGISTERED: Record<Kind, string> = {
    dup: '✅ 이 방을 중복확인 방으로 등록했습니다.\n같은 인스타 아이디가 다시 올라오면 바로 알리고, 매일 23:50에 올린 사람별 건수를 올립니다. (지금 현황: /중복확인)',
    tally: `✅ 이 방을 취합 방으로 등록했습니다.\n<code>#주제 #지역 내용</code> 으로 올리면 주제별·지역별로 모아 /취합 으로 보여줍니다 (<code>/취합 주제</code>, <code>/취합 11.2</code>). 지역: ${REGIONS.join(', ')}`,
};

async function command(ctx: Ctx, cmd: string, args: string, relay: boolean) {
    const kind = KIND_OF[cmd];
    if (ctx.chat.type === 'private') return void (await ctx.reply(`👥 /${cmd} 는 단체방에서 사용해주세요.`));
    if (args === '방등록' || args === '방해제') {
        if (!isSysadmin(ctx.from?.id)) return void (await ctx.reply('⛔ 시스템 관리자만 방을 등록·해제할 수 있습니다.'));
        await setRoom(ctx.chat.id, kind, args === '방등록', ctx.chat.title, relay);
        return void (await ctx.reply(args === '방등록' ? REGISTERED[kind] : `🔓 ${cmd} 방 등록을 해제했습니다.`, { parse_mode: 'HTML' }));
    }
    if (!(await isRoom(ctx.chat.id, kind, relay))) return void (await ctx.reply(`ℹ️ ${cmd} 방이 아닙니다. 시스템 관리자가 <code>/${cmd} 방등록</code> 으로 등록해주세요.`, { parse_mode: 'HTML' }));
    // 인자: 날짜(11.2) 와 취합 주제(#주제 또는 주제) — 둘 다 생략 가능
    const words = args.split(/\s+/).filter(Boolean);
    const dateWord = words.find((w) => /\d/.test(w) && parseFlexibleDate(w));
    const date = dateWord ? parseFlexibleDate(dateWord)! : today();
    const topic = words.filter((w) => w !== dateWord).join(' ').replace(/^#/, '') || undefined;
    if (kind === 'dup') {
        if (topic) return void (await ctx.reply(`⚠️ 날짜를 확인해주세요: "${args}" (예: /${cmd} 11.2)`));
        return void (await ctx.reply(await instaReport(ctx.chat.id, date), { parse_mode: 'HTML' }));
    }
    await replyLong(ctx, await tallyReport(ctx.chat.id, date, topic));
}

// 특전대·인터뷰보다 먼저 등록 (등록된 방의 '아이디/이름/…' 줄을 특전대 결과로 오인하지 않도록)
// relay: 카운셀링 봇이 /relay 로 넘겨준 글을 처리하는 봇 (아래 relayBot — 취합만, 중복확인은 시다봇 직접)
export function registerOnline(bot: Telegraf<any>, relay = false) {
    const run = (fn: (ctx: Ctx, next: () => Promise<void>) => Promise<unknown>) => async (ctx: Ctx, next: () => Promise<void>) => {
        try {
            await fn(ctx, next);
        } catch (err) {
            console.error('[온라인 방 처리 에러]:', err);
            await ctx.reply('⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하고, 계속되면 관리자에게 알려주세요.').catch(() => {});
        }
    };
    bot.hears(relay ? /^[\/!](취합)(?:@\w+)?(?:\s+(.+))?$/ : /^[\/!](중복확인|취합)(?:@\w+)?(?:\s+(.+))?$/, run((ctx) => command(ctx, ctx.match[1], (ctx.match[2] || '').trim(), relay)));
    bot.on('message', (ctx: Ctx, next) => {
        if (ctx.message.migrate_from_chat_id) rooms = null; // 방 ID 변경 (moveGroupChat 이 DB를 옮김)
        return next();
    });
    bot.on('text', run(async (ctx, next) => {
        const text: string = ctx.message.text;
        if (ctx.chat.type === 'private' || !ctx.from || /^[\/!]/.test(text)) return next();
        if (await isRoom(ctx.chat.id, 'dup', relay)) {
            const ids = parseInstaIds(text);
            if (ids.length) return saveInsta(ctx, ids);
        }
        if (await isRoom(ctx.chat.id, 'tally', relay)) {
            const t = parseTally(text);
            if (t) return saveTally(ctx, t);
        }
        return next();
    }));
}

/* ====================== 카운셀링 봇 전달 ====================== */
// 취합 방에 시다봇을 초대하지 않도록 카운셀링 봇이 받은 글을 /relay 로 넘겨줌. 같은 DB라 주소·비밀값은 cdabot_relay 에 (설정 불필요)
// 답(메시지·👍)은 직접 보내지 않고 모아서 돌려줌 → 카운셀링 봇이 자기 이름으로 보냄 (카운셀링 봇 토큰 불필요)
export type RelayAction = { method: string; payload: any };
const relayBot = new Telegraf<any>('0:relay'); // 토큰은 쓰지 않음 (텔레그램 호출을 아래에서 가로챔)
relayBot.botInfo = { id: 0, is_bot: true, first_name: 'relay', username: 'relay' } as any;
const outbox = new Map<number, RelayAction[]>();
relayBot.use((ctx: Ctx, next) => {
    const out = outbox.get(ctx.update.update_id) ?? [];
    ctx.telegram.callApi = async (method: string, payload: any) => {
        out.push({ method, payload });
        return { message_id: 0, date: 0, chat: ctx.chat, text: payload?.text };
    };
    return next();
});
relayBot.catch((err: unknown) => console.error('[카운셀링 봇 전달 처리 에러]:', err));
registerOnline(relayBot, true);

export async function handleRelay(update: any): Promise<RelayAction[]> {
    outbox.set(update.update_id, []);
    try {
        await relayBot.handleUpdate(update);
        return outbox.get(update.update_id)!;
    } finally {
        outbox.delete(update.update_id);
    }
}

// 시작할 때 (bot.ts) 카운셀링 봇이 읽을 주소를 적음. 비밀값은 처음 한 번 만들고 유지
export async function publishRelay(webhookUrl: string) {
    const url = webhookUrl.replace(/\/webhook\/?$/, '/relay');
    await query(`INSERT INTO cdabot_relay (id, url, secret) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url;`, [url, crypto.randomBytes(32).toString('hex')]);
}

export async function relaySecretOk(given: string): Promise<boolean> {
    const secret: string | undefined = (await query(`SELECT secret FROM cdabot_relay WHERE id = 1;`)).rows[0]?.secret;
    return !!secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}
