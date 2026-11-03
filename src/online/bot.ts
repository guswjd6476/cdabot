// 온라인 업무 (특전대·인터뷰와 별개, 조직 없음)
//   온라인 전도 — /온라인 방등록 (시스템 관리자, 시다봇이 있는 방): 올라온 인스타 양식 저장, 같은 아이디면 바로 중복 알림, 매일 23:50 지역별 현황 (/중복확인 도 같은 명령)
//   취합 — 카운셀링 봇이 지역 담당방의 '#주제 #지역 내용' 글을 넘겨줌 → 시스템 관리자가 카운셀링 봇 1:1 대화에서 /취합
import crypto from 'crypto';
import { Telegraf } from 'telegraf';
import { isSysadmin } from '../core/engine';
import { query } from '../db';
import { dayjs, escapeHtml as e, getErrorMessage, nowKst, parseFlexibleDate, replyLong } from '../utils';

type Ctx = any;
const today = () => nowKst().format('YYYY-MM-DD');
const md = (d: string) => `${Number(d.slice(5, 7))}.${Number(d.slice(8, 10))}`;

export const REGIONS = ['도봉', '성북', '노원', '중랑', '강북', '대학', '새신자', '이음'];
const NOT_PROFILE = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'tv', 'accounts', 's']);

/* ====================== 파싱 ====================== */

// 양식 '아이디/이름/나이/거주지/이성친구유무/기타사항' 줄 (아이디는 영문이 있어야 함 — 날짜 10/8/… 오인 방지) + instagram.com/아이디 링크.
// 같은 아이디의 줄과 링크는 한 건으로 합침. 링크는 추적용 ?뒤 값을 빼고 저장
// 새 양식은 '지역/인도자/아이디/…' — 앞 세 칸 중 영문 아이디 모양인 칸이 아이디, 그 앞은 지역·인도자, 뒤는 이름부터
export type InstaPost = { id: string; region?: string; guide?: string; name?: string; age?: string; residence?: string; relationship?: string; memo?: string; url?: string };
export function parseInstaPosts(text: string): InstaPost[] {
    const posts = new Map<string, InstaPost>();
    const get = (id: string) => posts.get(id) ?? posts.set(id, { id }).get(id)!;
    const cell = (s?: string) => (s && s.trim() !== '-' ? s.trim() : undefined) || undefined;
    for (const line of text.split('\n')) {
        const f = line.split('/');
        if (f.length < 3 || /:\/\/|instagram\.com/i.test(line)) continue; // 링크 줄은 아래에서
        const at = f.slice(0, 3).findIndex((x) => /^\s*@?[A-Za-z0-9._]{2,30}\s*$/.test(x) && /[a-z]/i.test(x));
        if (at < 0) continue;
        const [name, age, residence, relationship, ...rest] = f.slice(at + 1);
        Object.assign(get(f[at].trim().replace(/^@/, '').toLowerCase()), {
            region: cell(at >= 1 ? f[0] : undefined),
            guide: cell(at === 2 ? f[1] : undefined),
            name: cell(name), age: cell(age), residence: cell(residence), relationship: cell(relationship), memo: cell(rest.join('/')),
        });
    }
    const lines = [...posts.values()];
    const urls = [...text.matchAll(/instagram\.com\/([A-Za-z0-9._]{1,30})/gi)].map((m) => m[1].toLowerCase()).filter((id) => !NOT_PROFILE.has(id));
    // 양식 줄 하나 + 링크 하나인데 아이디가 다르면 한 건 — 텔레그램이 '__'를 기울임으로 바꾸며 줄의 밑줄을 지움 (링크 아이디가 맞음)
    if (lines.length === 1 && new Set(urls).size === 1 && lines[0].id !== urls[0]) {
        posts.clear();
        posts.set(urls[0], { ...lines[0], id: urls[0] });
    }
    for (const id of urls) get(id).url = `https://www.instagram.com/${id}`;
    return [...posts.values()];
}
export const parseInstaIds = (text: string) => parseInstaPosts(text).map((p) => p.id);

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

// 중복확인 방 목록은 메모리에 (모든 단체방 메시지마다 DB를 깨우지 않도록). 방 ID가 바뀌면 다시 읽음
let rooms: Promise<Set<string>> | null = null;
async function isDupRoom(chatId: number) {
    rooms ??= query(`SELECT chat_id::text AS id FROM cdabot_rooms WHERE kind = 'dup';`).then((r) => new Set(r.rows.map((x) => x.id as string)));
    return (await rooms.catch(() => ((rooms = null), new Set<string>()))).has(String(chatId));
}
async function setDupRoom(chatId: number, on: boolean, title?: string) {
    if (on) await query(`INSERT INTO cdabot_rooms (chat_id, kind, title) VALUES ($1, 'dup', $2) ON CONFLICT (chat_id, kind) DO UPDATE SET title = EXCLUDED.title;`, [String(chatId), title || null]);
    else await query(`DELETE FROM cdabot_rooms WHERE chat_id = $1 AND kind = 'dup';`, [String(chatId)]);
    rooms = null;
}

/* ====================== 중복확인 ====================== */

// '/중복확인 추가' 로 넣은 기존 아이디 (올린 사람 없음 — 사람별 건수에서 뺌)
const SEED_TG = 0;
// 올린 사람 이름: 웹에서 정한 실명(cdabot_online_names), 없으면 올릴 때 텔레그램 이름
const posterName = (tg: string, fallback: string) => `COALESCE((SELECT n.name FROM cdabot_online_names n WHERE n.poster_tg = ${tg}), ${fallback})`;

// '이름 / 아이디' 줄마다 마지막 칸의 아이디 (+ instagram.com 링크). 이미 이 방에 있는 아이디는 건너뜀
async function seedInsta(ctx: Ctx, text: string) {
    const ids = new Set(parseInstaIds(text));
    for (const m of text.matchAll(/\/\s*@?([A-Za-z0-9._]{1,30})\s*$/gm)) if (/[a-z]/i.test(m[1])) ids.add(m[1].toLowerCase());
    if (!ids.size) return void (await ctx.reply('⚠️ 아이디를 찾지 못했습니다. 한 줄에 하나씩 "이름 / 아이디" 로 적어주세요.'));
    let added = 0;
    for (const id of ids) {
        const r = await query(
            `INSERT INTO cdabot_insta_posts (chat_id, insta_id, poster_tg, poster_name, posted_date)
             SELECT $1, $2, $3, '기존 목록', $4 WHERE NOT EXISTS (SELECT 1 FROM cdabot_insta_posts WHERE chat_id = $1 AND insta_id = $2) RETURNING id;`,
            [String(ctx.chat.id), id, SEED_TG, today()]
        );
        added += r.rows.length;
    }
    await ctx.reply(`✅ 기존 아이디 ${added}개 추가${ids.size > added ? ` (이미 있던 ${ids.size - added}개 제외)` : ''}. 이제 이 아이디가 올라오면 중복으로 알립니다.`);
}

async function saveInsta(ctx: Ctx, posts: InstaPost[]) {
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || String(ctx.from.id);
    const dups: string[] = [];
    for (const p of posts) {
        const id = p.id;
        const prev = (
            await query(
                `SELECT poster_tg, ${posterName('cdabot_insta_posts.poster_tg', 'poster_name')} AS poster_name, to_char(posted_date, 'YYYY-MM-DD') AS date, count(*) OVER () AS n FROM cdabot_insta_posts
                 WHERE chat_id = $1 AND insta_id = $2 ORDER BY id LIMIT 1;`,
                [String(ctx.chat.id), id]
            )
        ).rows[0];
        await query(
            `INSERT INTO cdabot_insta_posts (chat_id, insta_id, poster_tg, poster_name, posted_date, dup, name, age, residence, relationship, memo, url, region, guide)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14);`,
            [String(ctx.chat.id), id, ctx.from.id, name, today(), !!prev, p.name ?? null, p.age ?? null, p.residence ?? null, p.relationship ?? null, p.memo ?? null, p.url ?? null, p.region ?? null, p.guide ?? null]
        );
        const first = Number(prev?.poster_tg) === SEED_TG ? '기존 목록에 있음' : `처음: ${e(prev?.poster_name)} (${md(prev?.date ?? today())})`;
        if (prev) dups.push(`• <b>${e(id)}</b> — ${first}${Number(prev.n) > 1 ? ` · 이미 ${prev.n}번 올라옴` : ''}`);
    }
    if (dups.length) await ctx.reply(`🚨 <b>중복 인스타</b>\n${dups.join('\n')}`, { parse_mode: 'HTML' });
    else await ctx.react('👍').catch(() => {});
}

// 지역별 → 대원별 오늘 건수 · 누적 (중복은 건수에서 빼고 따로). 지역은 웹에서 연결한 명단(고유번호)의 지역, 없으면 '지역 미연결'
// 지역 순서는 REGIONS, 그 밖의 지역은 가나다순, 미연결은 맨 끝
const NO_REGION = '지역 미연결';
async function instaReport(chatId: number | string, date = today()): Promise<string> {
    const rows = (
        await query(
            `SELECT ${posterName('p.poster_tg', '(array_agg(p.poster_name ORDER BY p.id DESC))[1]')} AS name,
                    (SELECT m."지역" FROM cdabot_online_names n JOIN members m ON m."고유번호" = n.member_code WHERE n.poster_tg = p.poster_tg) AS region,
                    count(*) FILTER (WHERE NOT p.dup) AS total,
                    count(*) FILTER (WHERE NOT p.dup AND p.posted_date = $2) AS today,
                    count(*) FILTER (WHERE p.dup AND p.posted_date = $2) AS dup_today
             FROM cdabot_insta_posts p WHERE p.chat_id = $1 AND p.posted_date <= $2 AND p.poster_tg <> ${SEED_TG}
             GROUP BY p.poster_tg ORDER BY today DESC, total DESC, name;`,
            [String(chatId), date]
        )
    ).rows.map((r) => ({ name: r.name as string, region: (r.region as string | null) || NO_REGION, total: Number(r.total), today: Number(r.today), dup: Number(r.dup_today) }));
    type Row = (typeof rows)[number];
    const sum = (xs: Row[], k: 'today' | 'total' | 'dup') => xs.reduce((s, r) => s + r[k], 0);
    const rank = (reg: string) => (reg === NO_REGION ? 99 : REGIONS.includes(reg) ? REGIONS.indexOf(reg) : 50);
    const regions = [...new Set(rows.map((r) => r.region))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'ko'));
    const blocks = regions.map((reg) => {
        const xs = rows.filter((r) => r.region === reg);
        const people = xs.map((r) => `• ${e(r.name)}  오늘 ${r.today} · 누적 ${r.total}${r.dup ? ` (중복 ${r.dup})` : ''}`);
        return `${reg === NO_REGION ? '❔' : '🔹'} <b>${reg}</b> — 오늘 ${sum(xs, 'today')}건 · 누적 ${sum(xs, 'total')}건\n${people.join('\n')}`;
    });
    const day = `${md(date)}(${'일월화수목금토'[dayjs(date).day()]})`;
    const head = `📊 <b>${day} 온라인 전도 현황</b>\n오늘 ${sum(rows, 'today')}건${sum(rows, 'dup') ? ` · 중복 ${sum(rows, 'dup')}건` : ''} · 올린 대원 ${rows.filter((r) => r.today || r.dup).length}명`;
    return blocks.length ? `${head}\n\n${blocks.join('\n\n')}` : `${head}\n\n아직 올라온 건이 없습니다.`;
}

// 그날 올라온 양식 내용 (모든 중복확인 방, 기존 목록 제외) — 개인정보라 시스템 관리자 1:1 에서만
async function instaList(date: string): Promise<string> {
    const rows = (
        await query(
            `SELECT insta_id, region, guide, name, age, residence, relationship, memo, url, ${posterName('cdabot_insta_posts.poster_tg', 'poster_name')} AS poster_name, dup FROM cdabot_insta_posts
             WHERE posted_date = $1 AND poster_tg <> ${SEED_TG} ORDER BY id;`,
            [date]
        )
    ).rows;
    if (!rows.length) return `📇 ${md(date)} 올라온 인스타가 없습니다.`;
    const lines = rows.map((r, i) => {
        const id = r.url ? `<a href="${r.url}">${e(r.insta_id)}</a>` : `<b>${e(r.insta_id)}</b>`;
        const cells = (xs: (string | null)[]) => xs.filter(Boolean).map((x) => e(x));
        const line = [...cells([r.region, r.guide]), id, ...cells([r.name, r.age, r.residence, r.relationship, r.memo])].join(' / ');
        return `${i + 1}. ${line}\n    └ ${e(r.poster_name)}${r.dup ? ' · 🚨중복' : ''}`;
    });
    return `📇 <b>${md(date)} 온라인 전도 명단</b> (${rows.length}건)\n<i>지역/인도자/아이디/이름/나이/거주지/이성친구유무/기타 └ 올린 사람</i>\n\n${lines.join('\n')}`;
}

// 매일 23:50 (bot.ts 스케줄) — 중복확인 방마다 오늘 현황
export async function sendDailyInstaReports(telegram: any) {
    const chats = (await query(`SELECT chat_id::text AS id FROM cdabot_rooms WHERE kind = 'dup';`)).rows.map((r) => r.id);
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

// 그날 모든 지역 담당방에서 올라온 주제마다 지역 순서대로 내용 (안 올린 지역은 '-'). topic 을 주면 그 주제만
async function tallyReport(date: string, topic?: string): Promise<string> {
    const rows = (await query(`SELECT topic, region, content FROM cdabot_tally_posts WHERE posted_date = $1 AND ($2::text IS NULL OR topic = $2) ORDER BY id;`, [date, topic ?? null]))
        .rows as Tally[];
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

const run = (fn: (ctx: Ctx, next: () => Promise<void>) => Promise<unknown>) => async (ctx: Ctx, next: () => Promise<void>) => {
    try {
        await fn(ctx, next);
    } catch (err) {
        console.error('[온라인 업무 처리 에러]:', err);
        await ctx.reply('⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하고, 계속되면 관리자에게 알려주세요.').catch(() => {});
    }
};

// 인자: 날짜(11.2) 와 주제(#주제 또는 주제) — 둘 다 생략 가능
function dateAndTopic(args: string) {
    const words = args.split(/\s+/).filter(Boolean);
    const dateWord = words.find((w) => /\d/.test(w) && parseFlexibleDate(w));
    return { date: dateWord ? parseFlexibleDate(dateWord)! : today(), topic: words.filter((w) => w !== dateWord).join(' ').replace(/^#/, '') || undefined };
}

async function dupCommand(ctx: Ctx, args: string) {
    const list = args.match(/^명단(?:\s+(.*))?$/);
    if (list) {
        if (ctx.chat.type !== 'private') return void (await ctx.reply('🔒 명단은 개인정보라 봇과 1:1 대화에서 /온라인 명단 으로 봐주세요.'));
        if (!isSysadmin(ctx.from?.id)) return void (await ctx.reply('⛔ 명단은 시스템 관리자만 볼 수 있습니다.'));
        const d = list[1] ? parseFlexibleDate(list[1]) : today();
        if (!d) return void (await ctx.reply(`⚠️ 날짜를 확인해주세요: "${list[1]}" (예: /온라인 명단 11.3)`));
        return replyLong(ctx, await instaList(d), { link_preview_options: { is_disabled: true } });
    }
    if (ctx.chat.type === 'private') return void (await ctx.reply('👥 /온라인 은 온라인 전도 방에서 사용해주세요. (명단: /온라인 명단)'));
    if (args === '방등록' || args === '방해제') {
        if (!isSysadmin(ctx.from?.id)) return void (await ctx.reply('⛔ 시스템 관리자만 방을 등록·해제할 수 있습니다.'));
        await setDupRoom(ctx.chat.id, args === '방등록', ctx.chat.title);
        return void (await ctx.reply(
            args === '방등록'
                ? '✅ 이 방을 온라인 전도 방으로 등록했습니다.\n올라온 인스타 양식을 저장하고, 같은 아이디가 다시 올라오면 바로 알리고, 매일 23:50에 지역별 현황을 올립니다. (지금 현황: /온라인)'
                : '🔓 온라인 전도 방 등록을 해제했습니다.'
        ));
    }
    if (!(await isDupRoom(ctx.chat.id))) return void (await ctx.reply('ℹ️ 온라인 전도 방이 아닙니다. 시스템 관리자가 <code>/온라인 방등록</code> 으로 등록해주세요.', { parse_mode: 'HTML' }));
    const seed = args.match(/^추가(?:\s+([\s\S]*))?$/);
    if (seed) {
        if (!isSysadmin(ctx.from?.id)) return void (await ctx.reply('⛔ 시스템 관리자만 기존 아이디를 넣을 수 있습니다.'));
        return seedInsta(ctx, seed[1] || '');
    }
    const { date, topic } = dateAndTopic(args);
    if (topic) return void (await ctx.reply(`⚠️ 날짜를 확인해주세요: "${args}" (예: /온라인 11.2)`));
    await ctx.reply(await instaReport(ctx.chat.id, date), { parse_mode: 'HTML' });
}

// 특전대·인터뷰보다 먼저 등록 (중복확인 방의 '아이디/이름/…' 줄을 특전대 결과로 오인하지 않도록)
export function registerOnline(bot: Telegraf<any>) {
    bot.hears(/^[\/!](?:온라인|중복확인)(?:@\w+)?(?:\s+([\s\S]+))?$/, run((ctx) => dupCommand(ctx, (ctx.match[1] || '').trim())));
    bot.on('message', (ctx: Ctx, next) => {
        if (ctx.message.migrate_from_chat_id) rooms = null; // 방 ID 변경 (moveGroupChat 이 DB를 옮김)
        return next();
    });
    // 글만 올린 것 + 인스타 캡처 사진·파일 아래 설명(캡션)
    bot.on(['text', 'photo', 'document'], run(async (ctx, next) => {
        const text: string = ctx.message.text ?? ctx.message.caption ?? '';
        if (ctx.chat.type === 'private' || !ctx.from || !text || /^[\/!]/.test(text) || !(await isDupRoom(ctx.chat.id))) return next();
        const posts = parseInstaPosts(text);
        return posts.length ? saveInsta(ctx, posts) : next();
    }));
}

/* ====================== 카운셀링 봇 전달 (취합) ====================== */
// 카운셀링 봇이 지역 담당방의 '#주제 #지역' 글과 1:1 대화의 /취합 을 /relay 로 넘겨줌. 같은 DB라 주소·비밀값은 cdabot_relay 에 (설정 불필요)
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
// 1:1 대화의 /취합 [주제] [날짜] — 시스템 관리자만 (모든 지역 담당방 것을 모아서)
relayBot.hears(/^[\/!]취합(?:@\w+)?(?:\s+(.+))?$/, run(async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!isSysadmin(ctx.from?.id)) return void (await ctx.reply('⛔ 취합 결과는 시스템 관리자만 볼 수 있습니다.'));
    const { date, topic } = dateAndTopic((ctx.match[1] || '').trim());
    await replyLong(ctx, await tallyReport(date, topic));
}));
// 지역 담당방의 '#주제 #지역 내용'
relayBot.on('text', run(async (ctx) => {
    if (ctx.chat.type === 'private' || !ctx.from || /^[\/!]/.test(ctx.message.text)) return;
    const t = parseTally(ctx.message.text);
    if (t) await saveTally(ctx, t);
}));

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
