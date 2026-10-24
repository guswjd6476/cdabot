import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import { Telegraf } from 'telegraf';
import {
    initDb,
    ensureChatRecord,
    getChat,
    getAllChats,
    updateChat,
    upsertReport,
    getReports,
    getChatsByRole,
    getRoles,
} from './db';
import {
    dayjs,
    escapeHtml,
    formatReportNumbers,
    formatMeetingWhen,
    formatYmdWithDay,
    getErrorMessage,
    getPastDateWarning,
    getWeekdayWarning,
    nowKst,
    parseFlexibleDate,
    parseFlexibleTime,
    parseReportNumbers,
    replyLong,
    stripDatePart,
    TZ,
} from './utils';
import { describeAccess, isSysadmin, registerCore } from './core/engine';
import { registerSida } from './sida/bot';
import { purgeExpiredPii } from './sida/store';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN이 설정되지 않았습니다.');
    process.exit(1);
}

// 관리자 = .env ADMIN_IDS (시다봇 시스템 관리자와 동일)
const isAdmin = isSysadmin;

function chatTitle(ctx: any): string {
    return 'title' in ctx.chat ? ctx.chat.title : ctx.chat.first_name || '대화방';
}

/* =====================================================
 * 🤖 텔레그램 봇 핸들러
 * ===================================================== */
const bot = new Telegraf(BOT_TOKEN);

bot.catch((err: unknown, ctx) => {
    console.error(`[Telegraf 처리 에러] Chat ID: ${ctx.chat?.id}`, err);
});

// 시다봇 공통 엔진 (입력 세션, /홈, /조직, 준비 중 역할 안내)
registerCore(bot);

// 방 제목 변경 시 DB 반영
bot.on('new_chat_title', async (ctx) => {
    await ensureChatRecord(ctx.chat.id, chatTitle(ctx)).catch((err) =>
        console.error('[방 제목 변경 반영 에러]:', getErrorMessage(err))
    );
});

// 봇이 방에 초대되면 레코드 생성
bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'member' || status === 'administrator') {
        await ensureChatRecord(ctx.chat.id, chatTitle(ctx)).catch((err) =>
            console.error('[초대 처리 에러]:', getErrorMessage(err))
        );
    }
});

bot.hears(/^[\/!](start|help|도움말)(?:@\w+)?$/i, async (ctx) => {
    await ctx.reply(
        '📌 <b>[CDA 봇 안내]</b>\n\n' +
            '• <b>내 ID 확인</b>: <code>/내아이디</code>\n' +
            '• <b>현재 방 상태</b>: <code>/상태확인</code>\n' +
            '• <b>일정 등록</b>: <code>/일정 10.8(목) 오후 7시</code> 또는 <code>/일정 미정</code>\n' +
            '• <b>방 역할 확인</b>: <code>/역할</code>\n' +
            '• <b>보고</b>: 역할이 지정된 방에 <code>항목: 숫자</code> 줄이 있는 글을 올리면 자동 접수 (수정하면 반영)\n\n' +
            '👑 <b>관리자</b>\n' +
            '• <b>방 역할 지정</b>: <code>/역할 특전대</code> · <code>/역할 해제</code>\n' +
            '• <b>결과 취합</b>: <code>/결과 특전대</code> 또는 <code>/결과 특전대 10.8</code>\n' +
            '• <b>전체 현황</b>: <code>관리자 점검</code>\n\n' +
            '🪖 <b>시다봇 역할</b> (1:1 대화)\n' +
            '• <code>/홈</code> 역할 선택 · <code>/특전대</code> 특전대 메뉴 · <code>/특전대 도움말</code> 특전대 사용법',
        { parse_mode: 'HTML' }
    );
});

// ADMIN_IDS 설정용: 내 텔레그램 ID / 방 ID 확인
bot.hears(/^[\/!](내아이디|myid|id)(?:@\w+)?$/i, async (ctx) => {
    await ctx.reply(
        `🆔 내 ID: <code>${ctx.from?.id}</code>\n💬 이 방 ID: <code>${ctx.chat.id}</code>` +
            (isAdmin(ctx.from?.id) ? '\n👑 관리자' : ''),
        { parse_mode: 'HTML' }
    );
});

bot.hears(/^[\/!]상태확인(?:@\w+)?$/i, async (ctx) => {
    try {
        await ensureChatRecord(ctx.chat.id, chatTitle(ctx));
        const record = await getChat(ctx.chat.id);
        const date = record?.meeting_date;
        await ctx.reply(
            `📋 <b>[${escapeHtml(record?.room_title)}] 상태</b>\n` +
                `• 일정: <b>${
                    !date ? '미등록' : /^\d{4}-\d{2}-\d{2}$/.test(date) ? formatMeetingWhen(formatYmdWithDay(date), record?.meeting_time) : escapeHtml(date)
                }</b>`,
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[/상태확인 에러]:', err);
        await ctx.reply(`⚠️ 조회 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 일정 등록 예시 (/일정 10.8(목) 오후 7시, /일정 미정)
bot.hears(/^[\/!]일정(?:@\w+)?(?:(?:\s+|(?=\d))([\s\S]+))?$/i, async (ctx) => {
    const rawInput = ctx.match[1]?.trim();
    if (!rawInput) {
        await ctx.reply('⚠️ 날짜를 함께 입력해주세요.\n예: <code>/일정 10.8(목) 오후 7시</code> 또는 <code>/일정 미정</code>', {
            parse_mode: 'HTML',
        });
        return;
    }
    try {
        await ensureChatRecord(ctx.chat.id, chatTitle(ctx));
        if (rawInput.includes('미정')) {
            await updateChat(ctx.chat.id, { meeting_date: '미정', meeting_time: null });
            await ctx.reply('📌 <b>일정이 [미정]으로 등록되었습니다.</b>', { parse_mode: 'HTML' });
            return;
        }
        const date = parseFlexibleDate(rawInput);
        if (!date) {
            await ctx.reply(`⚠️ 올바른 날짜 형식이 아닙니다. (예: 10-08, 10/8, 10.8(목), 10월 8일)\n❌ 인식하지 못한 입력: ${rawInput}`);
            return;
        }
        const time = parseFlexibleTime(stripDatePart(rawInput));
        await updateChat(ctx.chat.id, { meeting_date: date, meeting_time: time || null });
        await ctx.reply(
            `🗓 일정이 <b>${formatMeetingWhen(formatYmdWithDay(date), time)}</b>로 등록되었습니다.` +
                getWeekdayWarning(rawInput, date) +
                getPastDateWarning(date),
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[/일정 에러]:', err);
        await ctx.reply(`⚠️ 일정 등록 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 방 역할 확인/지정 (/역할, /역할 특전대, /역할 해제) — 역할 이름은 자유 입력이라 새 역할도 코드 수정 없이 사용
bot.hears(/^[\/!]역할(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (ctx) => {
    const input = ctx.match[1]?.trim();
    try {
        const record = await ensureChatRecord(ctx.chat.id, chatTitle(ctx));
        if (!input) {
            await ctx.reply(
                `🏷 이 방 역할: <b>${record.role ? escapeHtml(record.role) : '미지정'}</b>\n\n👤 <b>내가 접근 가능한 시다봇 역할</b>\n${await describeAccess(ctx)}`,
                { parse_mode: 'HTML' }
            );
            return;
        }
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ 역할 지정은 관리자만 할 수 있습니다.');
            return;
        }
        if (input === '해제') {
            await updateChat(ctx.chat.id, { role: null });
            await ctx.reply('🏷 역할이 해제되었습니다. 이제 이 방의 보고는 취합되지 않습니다.');
            return;
        }
        if (input.length > 50) {
            await ctx.reply('⚠️ 역할 이름은 50자 이하로 입력해주세요.');
            return;
        }
        await updateChat(ctx.chat.id, { role: input });
        await ctx.reply(
            `🏷 이 방 역할이 <b>${escapeHtml(input)}</b>(으)로 지정되었습니다.\n` +
                '이제 <code>항목: 숫자</code> 형식의 보고를 올리면 자동 취합됩니다.\n예:\n<code>전도: 3명\n섭외: 1명</code>',
            { parse_mode: 'HTML' }
        );
    } catch (err: unknown) {
        console.error('[/역할 에러]:', err);
        await ctx.reply(`⚠️ 역할 처리 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 역할별 결과 취합 (/결과 특전대, /결과 특전대 10.8) — 역할 생략 시 이 방 역할 사용
bot.hears(/^[\/!]결과(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.');
            return;
        }
        const input = ctx.match[1]?.trim() || '';
        const date = parseFlexibleDate(input) || nowKst().format('YYYY-MM-DD');
        const role = stripDatePart(input).replace(/\(\s*[월화수목금토일]\s*\)|오늘|내일|모레/g, '').trim() || (await getChat(ctx.chat.id))?.role;
        if (!role) {
            const roles = await getRoles();
            await ctx.reply(
                '⚠️ 역할을 함께 입력해주세요. 예: <code>/결과 특전대</code>\n' +
                    `등록된 역할: ${roles.length ? roles.map(escapeHtml).join(', ') : '없음'}`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const [reports, rooms] = await Promise.all([getReports(role, date), getChatsByRole(role)]);
        const total: Record<string, number> = {};
        const byRoom = new Map<string, { title: string; count: number; data: Record<string, number> }>();
        for (const r of reports) {
            const room = byRoom.get(r.chat_id) || { title: r.room_title || r.chat_id, count: 0, data: {} };
            room.count++;
            for (const [k, v] of Object.entries(r.data)) {
                total[k] = (total[k] || 0) + v;
                room.data[k] = (room.data[k] || 0) + v;
            }
            byRoom.set(r.chat_id, room);
        }
        const missing = rooms.filter((c) => !byRoom.has(c.chat_id));

        let msg = `📊 <b>[${escapeHtml(role)} 결과] ${formatYmdWithDay(date)}</b>\n━━━━━━━━━━━━━━━━━━\n`;
        msg += `• 보고: <b>${reports.length}</b>건 (방 ${byRoom.size}/${rooms.length})\n`;
        msg += Object.keys(total).length
            ? Object.entries(total).map(([k, v]) => `• ${escapeHtml(k)}: <b>${v}</b>`).join('\n') + '\n'
            : '• 아직 접수된 보고가 없습니다.\n';
        if (byRoom.size) {
            msg += '\n<b>[방별]</b>\n';
            for (const room of byRoom.values()) {
                msg += `• ${escapeHtml(room.title)} (${room.count}건): ${formatReportNumbers(room.data)}\n`;
            }
        }
        if (missing.length) msg += `\n⏳ <b>미보고</b>: ${missing.map((c) => escapeHtml(c.room_title)).join(', ')}\n`;
        await replyLong(ctx, msg);
    } catch (err: unknown) {
        console.error('[/결과 에러]:', err);
        await ctx.reply(`⚠️ 결과 취합 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

bot.hears(/^(?:[\/!]?관리자\s+)(점검|현황)$/i, async (ctx) => {
    try {
        if (!isAdmin(ctx.from?.id)) {
            await ctx.reply('⛔ 접근 권한이 없습니다.');
            return;
        }
        const chats = await getAllChats();
        const todayStr = nowKst().format('YYYY-MM-DD');
        const dated = chats.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.meeting_date || ''));
        let msg = `📊 <b>[전체 현황]</b>\n기준시각: ${nowKst().format('YYYY-MM-DD HH:mm')}\n━━━━━━━━━━━━━━━━━━\n`;
        msg += `• 등록된 방: <b>${chats.length}</b>개\n`;
        msg += `• 오늘 일정: <b>${dated.filter((c) => c.meeting_date === todayStr).length}</b>건\n`;
        msg += `• 예정 일정: <b>${dated.filter((c) => c.meeting_date! > todayStr).length}</b>건\n`;
        msg += `• 미정: <b>${chats.filter((c) => c.meeting_date === '미정').length}</b>건\n`;
        msg += `• 미등록: <b>${chats.filter((c) => !c.meeting_date).length}</b>건\n`;
        await replyLong(ctx, msg);
    } catch (err: unknown) {
        console.error('[관리자 점검 에러]:', err);
        await ctx.reply(`⚠️ 조회 중 오류 발생: ${getErrorMessage(err)}`);
    }
});

// 일반 텍스트 / 수정된 메시지 / 사진 설명글 처리 — 역할이 지정된 방이면 보고 감지
async function handleIncomingText(ctx: any, msg: any, rawText: string, source: 'text' | 'edited' | 'caption') {
    const text = rawText.trim();
    try {
        const record = await ensureChatRecord(ctx.chat.id, chatTitle(ctx));
        if (/^[!/]/.test(text) || /^관리자\s+/.test(text)) return; // 명령어는 위 핸들러에서 처리
        if (!record.role) return;
        const data = parseReportNumbers(text);
        if (Object.keys(data).length === 0) return;
        const isNew = await upsertReport({
            chatId: ctx.chat.id,
            messageId: msg.message_id,
            role: record.role,
            reportDate: dayjs.unix(msg.date).tz(TZ).format('YYYY-MM-DD'), // 수정돼도 msg.date는 처음 보낸 시각
            userId: ctx.from?.id,
            userName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' '),
            data,
            rawText: text,
        });
        await ctx.reply(`✅ <b>[${escapeHtml(record.role)}]</b> 보고 ${isNew ? '접수' : '수정 반영'}: ${formatReportNumbers(data)}`, {
            parse_mode: 'HTML',
            reply_parameters: { message_id: msg.message_id },
        });
    } catch (err: unknown) {
        console.error(`[텍스트 메시지 처리 에러] (${source}):`, getErrorMessage(err));
    }
}

// 특전대 모듈 (/특전대 명령, 버튼, 1:1 대화 입력 흐름) — 일반 텍스트 처리보다 먼저 등록
registerSida(bot);

bot.on('text', (ctx) => handleIncomingText(ctx, ctx.message, ctx.message.text, 'text'));
bot.on('edited_message', async (ctx) => {
    const msg: any = ctx.editedMessage;
    const text: string | undefined = msg?.text ?? msg?.caption;
    if (text) await handleIncomingText(ctx, msg, text, 'edited');
});
bot.on(['photo', 'document', 'video'], async (ctx) => {
    const caption: string | undefined = (ctx.message as any)?.caption;
    if (caption) await handleIncomingText(ctx, ctx.message, caption, 'caption');
});

/* =====================================================
 * ⏰ 크론 작업 (외부 크론 서비스가 HTTP로 호출)
 * ===================================================== */
async function morningJob() {
    // TODO: 오전 알림
}

async function nightJob() {
    // 보관기간(/특전대 보관기간)이 지난 결과의 이름·연락처 삭제
    const purged = await purgeExpiredPii();
    if (purged) console.log(`🗂 [개인정보 보관기간 만료] ${purged}건 이름·연락처 삭제`);
}

/* =====================================================
 * 🌐 HTTP 서버 (웹훅 + 크론)
 * ===================================================== */
const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'my_chat_member'] as const;

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // alwaysdata 처럼 경로를 붙여 배포해도 동작하도록 (예: /cdabot/webhook, /cdabot/cron-10pm)
    const route = '/' + (url.pathname.split('/').filter(Boolean).pop() || '');
    if (req.method === 'POST' && route === '/webhook') {
        return bot.webhookCallback(url.pathname)(req, res);
    }

    const cronJobs: Record<string, () => Promise<void>> = {
        '/cron-10am': morningJob,
        '/cron-10pm': nightJob,
    };
    const job = cronJobs[route];
    if (job) {
        // CRON_SECRET이 설정되어 있으면 ?key=비밀값 이 맞아야 실행
        const secret = process.env.CRON_SECRET;
        if (secret && url.searchParams.get('key') !== secret) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Forbidden');
        }
        try {
            await job();
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(`${url.pathname} executed`);
        } catch (err: unknown) {
            console.error(`[${url.pathname} 실행 에러]:`, getErrorMessage(err));
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(`Failed: ${getErrorMessage(err)}`);
        }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('CDA Bot Server is running OK');
});

const PORT = Number(process.env.PORT) || 8301;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // 예: https://도메인/webhook — 없으면 로컬 폴링 모드

server.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    await initDb();

    if (WEBHOOK_URL) {
        try {
            await bot.telegram.setWebhook(WEBHOOK_URL, { allowed_updates: [...ALLOWED_UPDATES] });
            console.log(`Telegram Webhook 등록 완료: ${WEBHOOK_URL}`);
        } catch (e: unknown) {
            console.error('Webhook 등록 에러:', getErrorMessage(e));
        }
    } else {
        // 로컬 개발: 웹훅을 지우고 폴링으로 실행 (운영 중인 토큰으로는 실행하지 말 것)
        await bot.launch({ allowedUpdates: [...ALLOWED_UPDATES], dropPendingUpdates: true });
        console.log('🤖 폴링 모드로 실행 중 (WEBHOOK_URL 미설정)');
    }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
