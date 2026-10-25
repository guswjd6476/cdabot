// 인터뷰 추적 모듈 (/인터뷰): 등록된 방에 올린 당일 인터뷰 결과지를 사람별로 저장하고,
// 카운셀링 봇 행정 DB(students)에 등록됐는지·몇 단계인지 추적. 특전대와 권한·방·데이터 모두 별개
import { Markup, Telegraf } from 'telegraf';
import { Access, askOrg, hasPerm, Need, registerModule, resolveAccess, session } from '../core/engine';
import { audit, autoEnroll, getGroupOrg, getMember, Perm, PERMS, setGroupOrg, setSetting, updateMembership, upsertMembership, upsertUser } from '../core/store';
import { dayjs, escapeHtml as e, getErrorMessage, nowKst, parseFlexibleDate, replyLong } from '../utils';
import { FOLLOW_UPS, InterviewKind, KINDS, parseInterviewSheet, sheetKind } from './parse';
import * as S from './store';

const NAME = '인터뷰';
const MK = S.MODULE_KEY;
const btn = Markup.button.callback;
type Ctx = any;
type A = Access & { org: { id: number; name: string } };
const inPrivate = (ctx: Ctx) => ctx.chat?.type === 'private';
const today = () => nowKst().format('YYYY-MM-DD');
const PERM_LABEL: Record<Perm, string> = { member: '결과 올리기', manager: '관리자', pii: '개인정보 조회' };

// 등록된 인터뷰 방이면 그 조직으로 자동 등록 (비활성화된 사람은 제외)
async function access(ctx: Ctx): Promise<Access> {
    if (!inPrivate(ctx) && ctx.chat && ctx.from) {
        const orgId = await getGroupOrg(ctx.chat.id, MK);
        if (orgId) {
            const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || String(ctx.from.id);
            const user = await upsertUser(ctx.from.id, name);
            if (await autoEnroll(orgId, user.id, MK, name)) await audit(orgId, user.id, 'interview.auto_enroll', ctx.chat.id);
            const s = await session(ctx);
            s.org = { ...(s.org || {}), [MK]: orgId };
        }
    }
    return resolveAccess(ctx, MK);
}

type Place = 'group' | 'private' | 'any';
type Action = { label?: string; need: Need; place: Place; run: (ctx: Ctx, a: A, args: string) => Promise<unknown> };
const ACTIONS: Record<string, Action> = {
    현황: { label: '📊 인터뷰·행정 현황', need: 'manager', place: 'private', run: (ctx, a, args) => report(ctx, a, args) },
    단계: { label: '📈 찾등·합등', need: 'pii', place: 'private', run: (ctx, a, args) => stageUps(ctx, a, args) },
    미등록: { label: '⏳ 행정 미등록', need: 'pii', place: 'private', run: (ctx, a, args) => unregistered(ctx, a, args) },
    검색: { need: 'pii', place: 'private', run: (ctx, a, args) => searchName(ctx, a, args) },
    도움말: { label: '❓ 도움말', need: null, place: 'any', run: (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }) },
    방등록: { need: 'manager', place: 'group', run: registerGroup },
    방해제: { need: 'manager', place: 'group', run: unregisterGroup },
    권한: { need: 'sysadmin', place: 'private', run: setPerms },
    보관기간: { need: 'sysadmin', place: 'private', run: setRetention },
};
// 개인정보(pii) 기능은 관리자 권한도 있어야 함
const allowed = (a: Access, x: Action) => hasPerm(a, x.need) && (x.need !== 'pii' || hasPerm(a, 'manager'));
const placeOk = (ctx: Ctx, x: Action) => x.place === 'any' || (x.place === 'private') === inPrivate(ctx);

async function dispatch(ctx: Ctx, sub = '', args = '') {
    const a = await access(ctx);
    if (!a.org) {
        if (a.orgChoices.length > 1) return askOrg(ctx, MK, a);
        return void (await ctx.reply(`🔒 ${NAME} 기능 권한이 없습니다. 관리자에게 요청하거나, 관리자가 등록한 인터뷰 방에서 결과지를 올려주세요.`));
    }
    const action = sub ? ACTIONS[sub] : undefined;
    if (sub && !action) return void (await ctx.reply(`❓ 알 수 없는 명령: ${sub}\n/인터뷰 도움말 로 사용법을 확인하세요.`));
    if (!action) return menu(ctx, a as A);
    if (!allowed(a, action)) return void (await ctx.reply('⛔ 이 기능을 사용할 권한이 없습니다.'));
    if (!placeOk(ctx, action)) return void (await ctx.reply(action.place === 'group' ? '👥 이 명령은 인터뷰 결과를 올리는 단체방에서 사용해주세요.' : '🔒 이 기능은 봇과 1:1 대화에서 사용해주세요.'));
    await action.run(ctx, a as A, args.trim());
}

async function menu(ctx: Ctx, a: A) {
    const items = Object.entries(ACTIONS).filter(([, x]) => x.label && allowed(a, x) && placeOk(ctx, x));
    const role = a.sysadmin ? '시스템 관리자' : (a.membership?.perms ?? []).map((p) => PERM_LABEL[p]).join(' · ') || '권한 없음';
    await ctx.reply(`🎙 <b>${NAME} 추적</b> · ${e(a.org.name)}\n👤 ${role}\n\n결과지는 등록된 인터뷰 방에 올리면 자동 저장됩니다.`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(items.map(([k, x]) => [btn(x.label!, `iv:a:${k}`)])),
    });
}

/* ====================== 결과지 저장 ====================== */

// 등록된 인터뷰 방 또는 봇과 1:1 대화에 '#이름/…' 줄이 있는 메시지 → 저장. 아니면 false (다른 핸들러로)
// '날짜: 10.20' 줄이 있으면 그 날짜로 (밀린 결과 입력), 없으면 오늘
async function handleSheet(ctx: Ctx, text: string): Promise<boolean> {
    const group = !inPrivate(ctx);
    if (group && !(await getGroupOrg(ctx.chat.id, MK))) return false;
    const entries = parseInterviewSheet(text);
    if (!entries.length) return false;
    const a = await access(ctx);
    const canPost = !!a.org && (hasPerm(a, 'member') || hasPerm(a, 'manager'));
    if (!group && !canPost) {
        if (!a.org && a.orgChoices.length > 1) return askOrg(ctx, MK, a).then(() => true);
        return false; // 인터뷰 권한 없는 사람의 1:1 대화는 다른 기능으로
    }
    if (!canPost) {
        await ctx.reply('🚫 결과를 저장할 수 없는 계정입니다. 관리자에게 문의해주세요.');
        return true;
    }
    const dateLine = text.normalize('NFKC').match(/^\s*(?:날짜|인터뷰일|일자)\s*[:：]?\s*(.+)$/m);
    const date = dateLine ? parseFlexibleDate(dateLine[1]) : today();
    if (!date || date > today()) {
        await ctx.reply(`⚠️ 날짜를 확인해주세요: "${dateLine?.[1].trim()}" (예: 날짜: 10.20 — 오늘 이후 날짜는 안 됨). 저장하지 않았습니다.`);
        return true;
    }
    const kind = sheetKind(text);
    const r = await S.saveInterviews(a.org!.id, a.userId, date, kind, entries);
    await audit(a.org!.id, a.userId, 'interview.save', ctx.message.message_id, { count: entries.length, date, kind });
    const by = FOLLOW_UPS.map((f) => `${f} ${entries.filter((x) => x.followUp === f).length}`).join(' · ');
    const noStatus = entries.filter((x) => !x.followUp).length;
    await ctx.reply(
        `🗂 ${md(date)}${date === today() ? '(오늘)' : ''} [${kind}] 인터뷰 결과 ${entries.length}명 저장 (새로 ${r.created} · 수정 ${r.updated})\n후속연결 ${by}${noStatus ? ` · 구분 없음 ${noStatus}` : ''}` +
            `\n<i>구분이 틀리면 맨 위에 "구분: ${kind === '향수행사' ? '당터뷰' : '향수행사'}" 줄을 넣어 다시 보내주세요.</i>` +
            (!dateLine && !group ? '\n💡 지난 날짜 결과면 맨 위에 "날짜: 10.20" 줄을 넣어 다시 보내주세요 (같은 날짜·이름은 덮어씀).' : '') +
            (r.linkError ? '\n⚠️ 행정 DB를 읽지 못해 행정 연결은 나중에 다시 시도합니다.' : ''),
        { parse_mode: 'HTML' }
    );
    return true;
}

/* ====================== 추적 화면 (관리자 1:1) ====================== */

// 인자에 '향수' 또는 '당터뷰'가 있으면 그 구분만. 나머지는 기간
function kindArg(args: string): { kind?: InterviewKind; rest: string } {
    const m = args.match(/향수(?:행사)?|당터뷰?/);
    if (!m) return { rest: args };
    return { kind: m[0].startsWith('향수') ? '향수행사' : '당터뷰', rest: args.replace(m[0], ' ').trim() };
}
const kindTitle = (k?: InterviewKind) => (k ? ` [${k}]` : '');

// '10.1~10.24' / '10.24' / 없으면 최근 days일
function range(args: string, days: number) {
    const [a, b] = args.split(/[~∼]/).map((x) => parseFlexibleDate(x.trim()));
    if (a) return { from: a, to: b ?? (args.includes('~') ? today() : a) };
    return { from: nowKst().subtract(days - 1, 'day').format('YYYY-MM-DD'), to: today() };
}
const md = (ymd: string) => dayjs(ymd).format('M/D');
const pct = (n: number, d: number) => (d ? ` (${Math.round((n / d) * 100)}%)` : '');
const ADMIN_WARN = '⚠️ 행정 DB(students)를 읽지 못해 행정 등록 여부를 표시하지 못했습니다.';

async function load(a: A, f: S.InterviewFilter) {
    const link = await S.linkPending(a.org.id);
    const res = await S.listInterviews(a.org.id, f);
    return { ...res, adminError: res.adminError ?? link.error };
}

// 행정 단계 순서 (카운셀링 봇과 같은 순서, 첫 글자로 비교)
const STAGE_ORDER = ['발', '찾', '합', '섭', '복', '예', '센'];
const stageRank = (k: string) => (k === '탈락' ? 99 : STAGE_ORDER.indexOf(k.charAt(0)) + 1 || 50);
const stageOf = (r: S.InterviewRow) => (r.dropped ? '탈락' : r.stage || '(단계 없음)');
function stageCounts(rows: S.InterviewRow[]) {
    const m = new Map<string, number>();
    for (const r of rows) {
        const k = stageOf(r);
        m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((x, y) => stageRank(x[0]) - stageRank(y[0])).map(([k, n]) => `${e(k)} ${n}`).join(' · ');
}

function groupLines(rows: S.InterviewRow[], keyOf: (r: S.InterviewRow) => string | null, admin: boolean) {
    const m = new Map<string, S.InterviewRow[]>();
    for (const r of rows) {
        const k = keyOf(r) || '(미입력)';
        m.set(k, [...(m.get(k) || []), r]);
    }
    return [...m.entries()]
        .sort((x, y) => y[1].length - x[1].length)
        .map(([k, rs]) => `• ${e(k)}: ${rs.length}명 · 후속O ${rs.filter((r) => r.follow_up === 'O').length}` + (admin ? ` · 행정 ${rs.filter((r) => r.student_id).length}` : ''))
        .join('\n');
}

async function report(ctx: Ctx, a: A, rawArgs: string) {
    const { kind, rest: args } = kindArg(rawArgs);
    const { from, to } = range(args, 30);
    const { rows, adminError } = await load(a, { from, to, kind });
    if (!rows.length) return void (await ctx.reply(`📊 ${md(from)}~${md(to)}${kindTitle(kind)} 인터뷰 결과가 없습니다.`));
    const linked = rows.filter((r) => r.student_id);
    const waiting = rows.filter((r) => !r.student_id && r.follow_up !== 'X');
    const fu = FOLLOW_UPS.map((f) => `${f} ${rows.filter((r) => r.follow_up === f).length}`).join(' · ');
    let html = `📊 <b>인터뷰·행정 현황${kindTitle(kind)}</b> ${md(from)}~${md(to)}\n\n• 인터뷰 <b>${rows.length}명</b> — 후속연결 ${fu}\n`;
    if (adminError) html += `\n${ADMIN_WARN}\n`;
    else {
        html += `• 행정 등록 <b>${linked.length}명</b>${pct(linked.length, rows.length)}${linked.length ? ` — ${stageCounts(linked)}` : ''}\n`;
        html += `• 행정 미등록 (후속 X 제외) ${waiting.length}명${waiting.some((r) => r.match_note === 'multi') ? ` · 동명이인 확인 필요 ${waiting.filter((r) => r.match_note === 'multi').length}명` : ''}\n`;
    }
    if (!kind) html += `\n<b>[구분별]</b>\n${groupLines(rows, (r) => r.kind, !adminError)}\n`;
    html += `\n<b>[인터뷰자별]</b>\n${groupLines(rows, (r) => r.interviewer, !adminError)}\n\n<b>[지역별]</b>\n${groupLines(rows, (r) => r.region, !adminError)}`;
    const kb = hasPerm(a, 'pii') && waiting.length ? Markup.inlineKeyboard([[btn('⏳ 미등록 명단', `iv:a:미등록`)]]) : {};
    await replyLong(ctx, html, kb);
}

const who = (r: S.InterviewRow) =>
    [r.region, r.guides.length ? `인도 ${r.guides.join(',')}` : null, r.interviewer ? `인터뷰 ${r.interviewer}` : null].filter(Boolean).map((x) => e(x)).join(' · ');

async function unregistered(ctx: Ctx, a: A, rawArgs: string) {
    const { kind, rest: args } = kindArg(rawArgs);
    const { from, to } = range(args, 60);
    const { rows, adminError } = await load(a, { from, to, kind });
    if (adminError) return void (await ctx.reply(ADMIN_WARN));
    const list = rows.filter((r) => !r.student_id && r.name && r.follow_up !== 'X').reverse(); // 오래된 것부터
    await audit(a.org.id, a.userId, 'interview.pii_view', 'unregistered', { count: list.length });
    if (!list.length) return void (await ctx.reply(`✅ ${md(from)}~${md(to)}${kindTitle(kind)} 후속연결 O·보류 중 행정 미등록자가 없습니다.`));
    const days = (d: string) => dayjs(today()).diff(dayjs(d), 'day');
    const lines = list.map(
        (r) =>
            `• ${md(r.interview_date)} <b>${e(r.name)}</b> [${r.kind}] [후속${e(r.follow_up ?? '?')}] ${who(r)} · ${days(r.interview_date)}일째` +
            (r.match_note === 'multi' ? ' · ⚠️ 행정에 같은 이름 여러 명' : '')
    );
    await replyLong(
        ctx,
        `⏳ <b>행정 미등록${kindTitle(kind)}</b> ${md(from)}~${md(to)} · ${list.length}명 (후속 X 제외, 개인정보 — 외부 공유 금지)\n` +
            `<i>행정에서 이름 + 인도자(인도자가 없으면 지역)로 찾습니다. 등록되면 다음 조회부터 빠집니다.</i>\n\n${lines.join('\n')}`
    );
}

async function searchName(ctx: Ctx, a: A, args: string) {
    if (!args) return void (await ctx.reply('사용법: /인터뷰 검색 이름'));
    const { rows, adminError } = await load(a, { name: args });
    await audit(a.org.id, a.userId, 'interview.pii_view', 'search', { q: args, count: rows.length });
    if (!rows.length) return void (await ctx.reply(`🔎 "${args}" 인터뷰 기록이 없습니다.`));
    const admin = (r: S.InterviewRow) =>
        adminError ? '행정: 확인 불가' : r.student_id ? `행정: <b>${e(r.dropped ? '탈락' : r.stage || '등록')}</b>` : r.match_note === 'multi' ? '행정: 같은 이름 여러 명 (확인 필요)' : '행정: 미등록';
    const blocks = rows.slice(0, 20).map(
        (r) =>
            `<b>${e(r.name)}</b> · ${r.interview_date} [${r.kind}] · 후속${e(r.follow_up ?? '?')} · ${admin(r)}\n${who(r)}` +
            (r.phone ? `\n📞 ${e(r.phone)}` : '') +
            (r.birth_date ? ` · 🎂 ${e(r.birth_date)}` : '') +
            (r.poster ? ` · 올린 사람 ${e(r.poster)}` : '') +
            (r.memo ? `\n<i>${e(r.memo.slice(0, 300))}</i>` : '')
    );
    await replyLong(ctx, `🔎 <b>"${e(args)}"</b> ${rows.length}건${rows.length > 20 ? ' (최근 20건만)' : ''} — 개인정보, 외부 공유 금지\n\n${blocks.join('\n\n')}`);
}

/* ====================== 찾등·합등 (단계 향상) ====================== */

// 기간 안에 행정에서 찾등·합등(찾_완료일·합_완료일)한 인터뷰 대상자. 기간 없으면 이번 주(월~오늘)
const UPS = [
    { key: 'chat_date', label: '찾등' },
    { key: 'hap_date', label: '합등' },
] as const;

async function stageUps(ctx: Ctx, a: A, rawArgs: string) {
    const { kind, rest: args } = kindArg(rawArgs);
    const ws = nowKst().subtract((nowKst().day() + 6) % 7, 'day').format('YYYY-MM-DD');
    const { from, to } = args ? range(args, 7) : { from: ws, to: today() };
    const { rows, adminError } = await load(a, { kind }); // 인터뷰가 오래전이어도 이 기간에 단계가 오른 사람은 포함
    if (adminError) return void (await ctx.reply(ADMIN_WARN));
    const seen = new Set<string>();
    const people = rows.filter((r) => r.student_id && !seen.has(r.student_id) && seen.add(r.student_id)); // 같은 사람 여러 번 인터뷰 → 최근 1건
    const inRange = (d?: string | null) => !!d && d >= from && d <= to;
    await audit(a.org.id, a.userId, 'interview.pii_view', 'stage_ups', { from, to });
    const sections = UPS.map(({ key, label }) => {
        const hit = people.filter((r) => inRange(r[key])).sort((x, y) => x[key]!.localeCompare(y[key]!));
        const lines = hit.map(
            (r) =>
                `• ${md(r[key]!)} <b>${e(r.name ?? '(이름 삭제됨)')}</b> [${r.kind}]${r.dropped ? ' <i>(현재 탈락)</i>' : ''} <i>(인터뷰 ${md(r.interview_date)}${who(r) ? ` · ${who(r)}` : ''})</i>`
        );
        return { label, hit, text: hit.length ? `\n<b>[${label} ${hit.length}명]</b>\n${lines.join('\n')}\n` : '' };
    });
    const total = sections.reduce((n, x) => n + x.hit.length, 0);
    // 구분별·인터뷰자별 찾등·합등 건수
    const tally = (keyOf: (r: S.InterviewRow) => string | null) => {
        const m = new Map<string, Record<string, number>>();
        for (const x of sections)
            for (const r of x.hit) {
                const k = keyOf(r) || '(미입력)';
                const c = m.get(k) ?? {};
                c[x.label] = (c[x.label] || 0) + 1;
                m.set(k, c);
            }
        return [...m.entries()].map(([k, c]) => `• ${e(k)}: ${UPS.map((u) => `${u.label} ${c[u.label] || 0}`).join(' · ')}`).join('\n');
    };
    await replyLong(
        ctx,
        `📈 <b>인터뷰 대상자 찾등·합등${kindTitle(kind)}</b> ${md(from)}~${md(to)}\n\n` +
            `• ${sections.map((x) => `${x.label} <b>${x.hit.length}명</b>`).join(' · ')}\n` +
            (total
                ? sections.map((x) => x.text).join('') + (kind ? '' : `\n<b>[구분별]</b>\n${tally((r) => r.kind)}\n`) + `\n<b>[인터뷰자별]</b>\n${tally((r) => r.interviewer)}\n`
                : '\n이 기간에 찾등·합등한 인터뷰 대상자가 없습니다.\n') +
            `\n<i>행정 DB의 찾·합 완료일 기준 · 개인정보 포함 — 외부 공유 금지</i>`
    );
}

/* ====================== 관리 ====================== */

async function registerGroup(ctx: Ctx, a: A) {
    await setGroupOrg(ctx.chat.id, MK, a.org.id, ctx.chat.title, a.userId);
    await audit(a.org.id, a.userId, 'interview.group.register', ctx.chat.id);
    await ctx.reply(`✅ 이 방을 [${a.org.name}] 인터뷰 결과 방으로 등록했습니다.\n이제 이 방에 올리는 결과지(#이름/지역/인도자/인터뷰자/…)는 자동 저장됩니다. (해제: /인터뷰 방해제)`);
}

async function unregisterGroup(ctx: Ctx, a: A) {
    await setGroupOrg(ctx.chat.id, MK, null);
    await audit(a.org.id, a.userId, 'interview.group.unregister', ctx.chat.id);
    await ctx.reply('🔓 인터뷰 결과 방 등록을 해제했습니다. 이제 이 방의 결과지는 저장되지 않습니다.');
}

// 결과지를 올린 적 없는 사람도 바로 관리자로 지정할 수 있게 없으면 등록
async function setPerms(ctx: Ctx, a: A, args: string) {
    const [id, list = '', ...rest] = args.split(/\s+/);
    const perms = [...new Set(list.split(',').map((x) => x.trim()))].filter((x): x is Perm => (PERMS as string[]).includes(x));
    if (!/^\d+$/.test(id || '') || !perms.length)
        return void (await ctx.reply('사용법: /인터뷰 권한 <텔레그램ID> member,manager,pii [이름]\nmember=결과 올리기, manager=관리자(현황), pii=개인정보 조회(미등록 명단·검색)'));
    let m = await getMember(a.org.id, MK, { telegramId: id });
    if (!m) {
        const user = await upsertUser(id, '');
        m = await upsertMembership(a.org.id, user.id, MK, rest.join(' ').slice(0, 30) || id, 'active');
    }
    await updateMembership(a.org.id, m.id, { perms, status: 'active' });
    await audit(a.org.id, a.userId, 'interview.member.perms', m.id, { perms });
    await ctx.reply(`🔑 ${m.display_name}: ${perms.map((p) => PERM_LABEL[p]).join(', ')}`);
}

async function setRetention(ctx: Ctx, a: A, args: string) {
    const days = Number(args);
    if (!Number.isInteger(days) || days < 0) return void (await ctx.reply('사용법: /인터뷰 보관기간 365 (일, 0 = 삭제 안 함)'));
    await setSetting(a.org.id, MK, 'pii_retention_days', days);
    await audit(a.org.id, a.userId, 'interview.retention', days);
    await ctx.reply(days ? `🗂 인터뷰 ${days}일이 지나면 이름·연락처·생년월일·메모를 삭제합니다 (건수·행정 연결은 유지).` : '🗂 인터뷰 개인정보를 자동 삭제하지 않습니다.');
}

const HELP =
    `🎙 <b>[인터뷰 추적 사용법]</b>\n\n` +
    `<b>결과 올리기</b> (등록된 인터뷰 방 또는 봇과 1:1)\n지금 쓰는 결과지 그대로 올리면 사람별로 저장됩니다.\n` +
    `• 밀린 결과는 맨 위에 <code>날짜: 10.20</code> 줄을 넣어 봇에게 1:1로 보내면 그 날짜로 저장\n` +
    `• 제목에 '향수'가 있으면 <b>향수행사</b>, 없으면 <b>당터뷰</b>로 구분 (직접 지정: <code>구분: 향수행사</code>)\n` +
    `<code>▪️후속연결O\n#이름/지역/인도자/인터뷰자/메모…</code>\n` +
    `• <code>▪️후속연결O / 보류 / X</code> 아래 줄이 그 상태로 저장\n• 연락처·생년월일(<code>생년월일: 990315</code>)은 메모에서 자동 인식\n` +
    `• 같은 날 같은 이름을 다시 올리면 덮어씀\n\n` +
    `<b>관리자</b> (봇과 1:1) — 명령 뒤에 <code>향수</code> 또는 <code>당터뷰</code>를 붙이면 그 구분만 (예: <code>/인터뷰 단계 향수 10.1~10.24</code>)\n• <code>/인터뷰 현황 [10.1~10.24]</code> — 인터뷰 수, 행정 등록·단계, 인터뷰자별·지역별\n` +
    `• <code>/인터뷰 미등록 [기간]</code> — 후속 O·보류인데 행정에 없는 사람 (개인정보 권한)\n• <code>/인터뷰 검색 이름</code> (개인정보 권한)\n` +
    `• 단체방에서 <code>/인터뷰 방등록</code> · <code>방해제</code>\n` +
    `• <code>/인터뷰 단계 [10.1~10.24]</code> — 그 기간에 찾등·합등한 인터뷰 대상자 (기본 이번 주, 개인정보 권한)\n\n` +
    `<b>시스템 관리자</b>: <code>/인터뷰 권한 ID manager,pii [이름]</code> · <code>/인터뷰 보관기간 365</code>\n\n` +
    `행정 등록은 카운셀링 봇 행정 DB에서 <b>이름 + 인도자</b>(인도자가 없으면 지역)로 찾습니다. 같은 이름이 여러 명이면 연결하지 않고 '확인 필요'로 둡니다.`;

export function registerInterview(bot: Telegraf<any>) {
    registerModule({ key: MK, name: NAME, openMenu: (ctx) => dispatch(ctx), help: HELP });

    const run = (fn: (ctx: Ctx, next: () => Promise<void>) => Promise<unknown>) => async (ctx: Ctx, next: () => Promise<void>) => {
        try {
            await fn(ctx, next);
        } catch (err) {
            console.error(`[${NAME} 처리 에러]:`, err);
            await ctx.reply(`⚠️ 처리 중 오류가 발생했습니다: ${getErrorMessage(err)}`).catch(() => {});
        }
    };

    bot.hears(/^[\/!](?:인터뷰|iv)(?:@\w+)?(?:\s+(\S+))?(?:\s+([\s\S]+))?$/i, run((ctx) => dispatch(ctx, ctx.match[1] || '', ctx.match[2] || '')));
    bot.action(/^iv:a:(\S+)$/, run(async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        await dispatch(ctx, ctx.match[1]);
    }));
    bot.on('text', run(async (ctx, next) => {
        const text: string = ctx.message.text;
        if (/^[\/!]/.test(text) || !(await handleSheet(ctx, text))) return next();
    }));
}
