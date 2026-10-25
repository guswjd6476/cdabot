// 시다봇 공통 엔진: 역할(모듈) 등록, 사용자 식별, 조직 선택, 서버 측 권한 검사, 입력 세션
import { Markup, Telegraf } from 'telegraf';
import { escapeHtml, getErrorMessage } from '../utils';
import { createOrg, getUserMemberships, listMembers, listOrgs, loadSession, Membership, Perm, saveSession, upsertUser } from './store';

// 시스템 관리자 = .env ADMIN_IDS (기존 봇 관리자와 동일). 모든 조직·모듈의 모든 권한
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
export const isSysadmin = (telegramId?: number | string) => !!telegramId && ADMIN_IDS.includes(String(telegramId));

export interface BotModule {
    key: string; // DB에 저장되는 모듈 키 (예: special)
    name: string; // 명령어·표시 이름 (예: 특전대)
    openMenu(ctx: any): Promise<void>;
    help: string;
}
export const MODULES: BotModule[] = [];
// 다음에 추가할 역할: 같은 형태로 src/<모듈>/bot.ts 를 만들고 registerModule 하면 /이름 명령이 생김
export const PLANNED_MODULES = ['전도교관', '전도부장'];
export const registerModule = (m: BotModule) => MODULES.push(m);

export type Need = Perm | 'sysadmin' | null;

export interface Access {
    userId: number;
    telegramId: number;
    sysadmin: boolean;
    org?: { id: number; name: string };
    orgChoices: { id: number; name: string }[];
    membership?: Membership;
    memberships: Membership[];
}

// 서버 측 권한 판정 — 버튼 노출과 무관하게 모든 요청에서 호출
export function hasPerm(a: Pick<Access, 'sysadmin' | 'membership'>, need: Need): boolean {
    if (need === null) return true;
    if (a.sysadmin) return true;
    if (need === 'sysadmin') return false;
    return a.membership?.status === 'active' && a.membership.perms.includes(need);
}

export async function session(ctx: any): Promise<Record<string, any>> {
    if (!ctx.state.sess) {
        ctx.state.sess = await loadSession(ctx.from.id);
        ctx.state.sessJson = JSON.stringify(ctx.state.sess);
    }
    return ctx.state.sess;
}

export async function resolveAccess(ctx: any, moduleKey: string): Promise<Access> {
    const from = ctx.from;
    const user = await upsertUser(from.id, [from.first_name, from.last_name].filter(Boolean).join(' '));
    const sysadmin = isSysadmin(from.id);
    const memberships = await getUserMemberships(user.id, moduleKey);
    const orgChoices = sysadmin
        ? await listOrgs()
        : [...new Map(memberships.map((m) => [m.org_id, { id: m.org_id, name: m.org_name }])).values()];
    const chosen = (await session(ctx)).org?.[moduleKey];
    const org = orgChoices.find((o) => o.id === chosen) ?? (orgChoices.length === 1 ? orgChoices[0] : undefined);
    return {
        userId: user.id,
        telegramId: from.id,
        sysadmin,
        org,
        orgChoices,
        memberships,
        membership: memberships.find((m) => m.org_id === org?.id),
    };
}

export async function askOrg(ctx: any, moduleKey: string, a: Access) {
    await ctx.reply('🏢 사용할 조직을 선택해주세요.', Markup.inlineKeyboard(a.orgChoices.map((o) => [Markup.button.callback(o.name, `core:org:${moduleKey}:${o.id}`)])));
}

// 관리자에게 알림 (시스템 관리자 + 해당 조직 모듈 관리자). 실패해도 본 작업은 계속
export async function notifyManagers(telegram: any, orgId: number, moduleKey: string, html: string, extra: Record<string, unknown> = {}) {
    const managers = (await listMembers(orgId, moduleKey)).filter((m) => m.perms.includes('manager')).map((m) => m.telegram_id);
    for (const id of new Set([...ADMIN_IDS, ...managers])) {
        await telegram.sendMessage(id, html, { parse_mode: 'HTML', ...extra }).catch((e: unknown) => console.error(`[관리자 알림 실패] ${id}:`, getErrorMessage(e)));
    }
}

// 접근 가능한 역할 한 줄 요약 (/역할, /홈 에서 사용)
export async function describeAccess(ctx: any): Promise<string> {
    const lines: string[] = [];
    for (const m of MODULES) {
        const a = await resolveAccess(ctx, m.key);
        const active = a.memberships.filter((x) => x.status === 'active');
        if (a.sysadmin) lines.push(`• ${m.name}: 시스템 관리자`);
        else if (active.length) lines.push(`• ${m.name}: ${active.map((x) => `${escapeHtml(x.org_name)}(${x.perms.join(',')})`).join(', ')}`);
        else lines.push(`• ${m.name}: 접근 권한 없음 — <code>/${m.name}</code> 에서 가입 요청`);
    }
    for (const p of PLANNED_MODULES) lines.push(`• ${p}: 준비 중`);
    return lines.join('\n');
}

export function registerCore(bot: Telegraf<any>) {
    // 입력 세션 저장 (바뀐 경우만)
    bot.use(async (ctx: any, next) => {
        await next();
        if (ctx.state.sess && ctx.from && JSON.stringify(ctx.state.sess) !== ctx.state.sessJson) {
            await saveSession(ctx.from.id, ctx.state.sess).catch((e) => console.error('[세션 저장 에러]:', getErrorMessage(e)));
        }
    });

    // 단체방: 봇이 이 방에 보내는 버튼에 '연 사람 ID'를 붙이고(~ID), 다른 사람이 누르면 막음.
    // 가입 승인 버튼은 관리자 누구나 누를 수 있게 제외 (권한은 처리할 때 서버에서 확인)
    bot.use(async (ctx: any, next) => {
        if (ctx.chat && ctx.chat.type !== 'private' && ctx.from) {
            const tg = ctx.telegram;
            const callApi = tg.callApi.bind(tg);
            tg.callApi = (method: string, payload: any, opts: any) => {
                if (payload && String(payload.chat_id) === String(ctx.chat.id)) {
                    for (const b of payload.reply_markup?.inline_keyboard?.flat() ?? []) {
                        if (b.callback_data && !b.callback_data.includes('~') && !/^sd:(ap|rj):/.test(b.callback_data)) b.callback_data += `~${ctx.from.id}`;
                    }
                    // 누구에게 하는 답인지 보이도록 원래 메시지에 답장으로
                    if (ctx.message && /^send/.test(method) && !payload.reply_parameters) {
                        payload.reply_parameters = { message_id: ctx.message.message_id, allow_sending_without_reply: true };
                    }
                }
                return callApi(method, payload, opts);
            };
        }
        const cq = ctx.callbackQuery;
        if (cq?.data?.includes('~')) {
            const [data, owner] = cq.data.split('~');
            if (owner !== String(ctx.from?.id)) return void (await ctx.answerCbQuery('본인이 연 메뉴만 누를 수 있습니다.', { show_alert: true }).catch(() => {}));
            cq.data = data;
        }
        return next();
    });

    bot.hears(/^[\/!](홈|home)(?:@\w+)?$/i, async (ctx) => {
        try {
            await ctx.reply(`🏠 <b>시다봇</b> — 역할을 선택하세요\n\n${await describeAccess(ctx)}`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard(MODULES.map((m) => [Markup.button.callback(m.name, `core:open:${m.key}`)])),
            });
        } catch (err) {
            console.error('[/홈 에러]:', err);
            await ctx.reply('⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하고, 계속되면 관리자에게 알려주세요.');
        }
    });

    bot.hears(new RegExp(`^[\\/!](${PLANNED_MODULES.join('|')})(?:@\\w+)?(?:\\s|$)`), (ctx) =>
        ctx.reply(`🛠 ${ctx.match[1]} 업무는 아직 준비 중입니다.`)
    );

    // 조직 목록·생성 (시스템 관리자)
    bot.hears(/^[\/!]조직(?:@\w+)?(?:\s+생성\s+(.+))?$/, async (ctx) => {
        try {
            if (!isSysadmin(ctx.from?.id)) return void (await ctx.reply('⛔ 시스템 관리자만 사용할 수 있습니다.'));
            const name = ctx.match[1]?.trim();
            if (name) {
                const org = await createOrg(name.slice(0, 50));
                await ctx.reply(org ? `🏢 조직 [${org.name}] 생성 (ID ${org.id})` : '⚠️ 같은 이름의 조직이 이미 있습니다.');
                return;
            }
            const orgs = await listOrgs();
            await ctx.reply(`🏢 <b>조직 목록</b>\n${orgs.map((o) => `• ${escapeHtml(o.name)} (ID ${o.id})`).join('\n')}\n\n생성: <code>/조직 생성 이름</code>`, {
                parse_mode: 'HTML',
            });
        } catch (err) {
            console.error('[/조직 에러]:', err);
            await ctx.reply('⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하고, 계속되면 관리자에게 알려주세요.');
        }
    });

    bot.action(/^core:(open|org):(\w+)(?::(\d+))?$/, async (ctx: any) => {
        await ctx.answerCbQuery().catch(() => {});
        const mod = MODULES.find((m) => m.key === ctx.match[2]);
        if (!mod) return;
        try {
            if (ctx.match[1] === 'org') {
                const a = await resolveAccess(ctx, mod.key);
                const orgId = Number(ctx.match[3]);
                // 선택한 조직이 실제로 접근 가능한지 서버에서 다시 확인
                if (!a.orgChoices.some((o) => o.id === orgId)) return void (await ctx.reply('⛔ 접근할 수 없는 조직입니다.'));
                const s = await session(ctx);
                s.org = { ...(s.org || {}), [mod.key]: orgId };
            }
            await mod.openMenu(ctx);
        } catch (err) {
            console.error('[core 버튼 에러]:', err);
            await ctx.reply('⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하고, 계속되면 관리자에게 알려주세요.');
        }
    });
}
