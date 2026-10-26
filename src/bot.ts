import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import http from 'http';
import { Telegraf } from 'telegraf';
import { runMigrations } from './db';
import { getErrorMessage } from './utils';
import { describeAccess, isSysadmin, registerCore } from './core/engine';
import { registerSida } from './sida/bot';
import { registerInterview, syncAdminFinds } from './interview/bot';
import { purgeExpiredInterviews } from './interview/store';
import { purgeExpiredPii } from './sida/store';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN이 설정되지 않았습니다.');
    process.exit(1);
}

/* =====================================================
 * 🤖 텔레그램 봇 (시다봇)
 * ===================================================== */
const bot = new Telegraf(BOT_TOKEN);

bot.catch((err: unknown, ctx) => {
    console.error(`[Telegraf 처리 에러] Chat ID: ${ctx.chat?.id}`, err);
});

// 공통 엔진 (입력 세션, 단체방 버튼 보호, /홈, /조직, 준비 중 역할 안내)
registerCore(bot);

bot.hears(/^[\/!](start|help|도움말)(?:@\w+)?$/i, async (ctx) => {
    await ctx.reply(
        '📌 <b>[시다봇 안내]</b>\n\n' +
            '• <code>/특전대</code> — 특전대 메뉴 (활동 시간 제출, 결과 제출, 현황)\n' +
            '• <code>/특전대 도움말</code> — 특전대 사용법\n' +
            '• <code>/인터뷰</code> — 인터뷰 결과·행정 등록 추적\n' +
            '• <code>/홈</code> · <code>/역할</code> — 내가 쓸 수 있는 역할\n' +
            '• <code>/내아이디</code> — 내 텔레그램 ID (대원 등록·관리자 설정용)',
        { parse_mode: 'HTML' }
    );
});

// ADMIN_IDS 설정·대원 등록용: 내 텔레그램 ID / 방 ID 확인
bot.hears(/^[\/!](내아이디|myid|id)(?:@\w+)?$/i, async (ctx) => {
    await ctx.reply(
        `🆔 내 ID: <code>${ctx.from?.id}</code>\n💬 이 방 ID: <code>${ctx.chat.id}</code>` + (isSysadmin(ctx.from?.id) ? '\n👑 시스템 관리자' : ''),
        { parse_mode: 'HTML' }
    );
});

bot.hears(/^[\/!]역할(?:@\w+)?$/i, async (ctx) => {
    try {
        await ctx.reply(`👤 <b>내가 접근 가능한 역할</b>\n${await describeAccess(ctx)}`, { parse_mode: 'HTML' });
    } catch (err: unknown) {
        console.error('[/역할 에러]:', err);
        await ctx.reply('⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하고, 계속되면 관리자에게 알려주세요.');
    }
});

// 특전대 모듈 (/특전대 명령, 버튼, 입력 흐름)
registerSida(bot);
// 인터뷰 추적 모듈 (/인터뷰 — 특전대와 별개)
registerInterview(bot);

/* =====================================================
 * ⏰ 크론 (외부 크론 서비스가 HTTP로 호출)
 * ===================================================== */
async function nightJob() {
    // 보관기간(/특전대 보관기간)이 지난 결과의 이름·연락처 삭제
    const purged = await purgeExpiredPii();
    if (purged) console.log(`🗂 [개인정보 보관기간 만료] ${purged}건 이름·연락처 삭제`);
    const purgedIv = await purgeExpiredInterviews();
    if (purgedIv) console.log(`🗂 [인터뷰 개인정보 보관기간 만료] ${purgedIv}건 삭제`);
}

/* =====================================================
 * 🌐 HTTP 서버 (웹훅 + 크론)
 * ===================================================== */
const ALLOWED_UPDATES = ['message', 'callback_query'] as const;
// 웹훅 위조 방지: 텔레그램이 보내는 헤더 비밀값 (토큰에서 파생 — 별도 설정 불필요)
const WEBHOOK_SECRET = crypto.createHash('sha256').update(BOT_TOKEN).digest('hex');

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // alwaysdata 처럼 경로를 붙여 배포해도 동작하도록 (예: /cdabot/webhook, /cdabot/cron-10pm)
    const route = '/' + (url.pathname.split('/').filter(Boolean).pop() || '');
    if (req.method === 'POST' && route === '/webhook') {
        return bot.webhookCallback(url.pathname, { secretToken: WEBHOOK_SECRET })(req, res);
    }

    const cronJobs: Record<string, () => Promise<void>> = {
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
            return res.end(`${route} executed`);
        } catch (err: unknown) {
            console.error(`[${route} 실행 에러]:`, getErrorMessage(err));
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Failed'); // 자세한 내용은 서버 로그에만
        }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('CDA Bot Server is running OK');
});

const PORT = Number(process.env.PORT) || 8301;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // 예: https://도메인/cdabot/webhook — 없으면 로컬 폴링 모드

server.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    try {
        await runMigrations();
        console.log('✅ [DB 점검] 시다봇 테이블 점검 완료');
    } catch (err: unknown) {
        console.error('🚨 [DB 마이그레이션 실패] 시다봇 기능이 동작하지 않을 수 있습니다:', getErrorMessage(err));
    }

    // 행정(카운셀링 봇) 찾등 → 특전대 찾기건 자동 등록 (10분마다)
    const sync = () => syncAdminFinds(bot.telegram).catch((err) => console.error('[행정 찾등 반영 실패]:', getErrorMessage(err)));
    void sync();
    setInterval(sync, 10 * 60 * 1000);

    if (WEBHOOK_URL) {
        try {
            await bot.telegram.setWebhook(WEBHOOK_URL, { allowed_updates: [...ALLOWED_UPDATES], secret_token: WEBHOOK_SECRET });
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
