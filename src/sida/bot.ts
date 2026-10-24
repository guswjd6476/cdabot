// 특전대 모듈: 메뉴·명령어, 활동 가능 시간 제출, 당일 결과 제출, 보고서, 관리자 기능
// 모든 기능은 봇과의 1:1 대화에서만 동작 (단체방에 개인정보가 올라가지 않게)
import { Markup, Telegraf } from 'telegraf';
import { Access, askOrg, hasPerm, Need, notifyManagers, registerModule, resolveAccess, session } from '../core/engine';
import { audit, autoEnroll, getGroupOrg, listGroupChats, getMember, setGroupOrg, getSettings, listMembers, listOrgs, Membership, Perm, PERMS, setSetting, updateMembership, upsertMembership, upsertUser } from '../core/store';
import { dayjs, escapeHtml, getErrorMessage, nowKst, parseFlexibleDate, replyLong, splitLongMessage } from '../utils';
import * as T from './time';
import * as R from './result';
import * as S from './store';

const NAME = '특전대';
const MK = S.MODULE_KEY;
const btn = Markup.button.callback;
type Ctx = any;
type A = Access & { org: { id: number; name: string } };
type Buttons = (ReturnType<typeof btn> | ReturnType<typeof Markup.button.url>)[][];

const PERM_LABEL: Record<Perm, string> = { member: '대원', manager: '팀 관리자', pii: '개인정보 조회' };
const e = escapeHtml;
const today = () => nowKst().format('YYYY-MM-DD');
const weekStartOf = (ymd: string) => {
    const d = dayjs(ymd);
    return d.subtract((d.day() + 6) % 7, 'day').format('YYYY-MM-DD');
};
const dateOf = (weekStart: string, w: number) => dayjs(weekStart).add(w - 1, 'day');
const weekLabel = (ws: string) => `${dayjs(ws).format('M/D')}~${dateOf(ws, 7).format('M/D')}`;
const chunk = <X>(items: X[], n: number) => Array.from({ length: Math.ceil(items.length / n) }, (_, i) => items.slice(i * n, i * n + n));
const weekdayOf = (ymd: string) => dayjs(ymd).day() || 7; // 월=1 … 일=7

async function show(ctx: Ctx, html: string, buttons?: Buttons) {
    const kb = buttons ? Markup.inlineKeyboard(buttons) : {};
    if (ctx.callbackQuery?.message && html.length < 4000) {
        try {
            return await ctx.editMessageText(html, { parse_mode: 'HTML', ...kb });
        } catch (err) {
            if (/not modified/.test(getErrorMessage(err))) return;
        }
    }
    await replyLong(ctx, html, kb);
}

const inPrivate = (ctx: Ctx) => ctx.chat?.type === 'private';
// 이름·연락처를 지금 이 대화에 보여도 되는지: 개인정보 권한 + 1:1 대화 (단체방에는 항상 가림)
const piiHere = (ctx: Ctx, a: A) => hasPerm(a, 'pii') && inPrivate(ctx);
const dmButton = (ctx: Ctx) => {
    const me = ctx.botInfo?.username;
    return me ? Markup.inlineKeyboard([[Markup.button.url('1:1 대화 열기', `https://t.me/${me}?start=sd`)]]) : {};
};
// 대원 기능은 단체방, 관리자 기능은 1:1 대화에서만 (권한 없는 기능은 장소와 무관하게 ⛔)
type Place = 'group' | 'private' | 'any';
const placeOf = (x: Action): Place => x.place ?? (x.need === 'member' ? 'group' : x.need ? 'private' : 'any');
const placeOk = (ctx: Ctx, x: Action) => placeOf(x) !== (inPrivate(ctx) ? 'group' : 'private');
const MSG_GO_GROUP = '👥 대원 기능(활동 시간·결과 제출, 내 현황)은 특전대 단체방에서 사용해주세요.';
const MSG_GO_DM = '🔒 관리자 기능은 봇과 1:1 대화에서 사용해주세요.';
async function wrongPlace(ctx: Ctx, x: Action): Promise<boolean> {
    if (placeOk(ctx, x)) return false;
    if (inPrivate(ctx)) await ctx.reply(x.need === 'member' ? MSG_GO_GROUP : '👥 이 명령은 특전대 단체방에서 사용해주세요.');
    else await ctx.reply(MSG_GO_DM, dmButton(ctx));
    return true;
}
const FLOW_TTL_MS = 30 * 60 * 1000; // 단체방에서 진행 중 입력이 일반 대화를 먹지 않도록 30분 지나면 무시

// 개인정보가 담긴 자료는 요청한 사람의 1:1 대화로만 보냄
async function sendPrivately(ctx: Ctx, html: string, doc?: { buf: Buffer; filename: string; caption: string }) {
    try {
        for (const part of splitLongMessage(html)) await ctx.telegram.sendMessage(ctx.from.id, part, { parse_mode: 'HTML' });
        if (doc) await ctx.telegram.sendDocument(ctx.from.id, { source: doc.buf, filename: doc.filename }, { caption: doc.caption });
        if (!inPrivate(ctx)) await ctx.reply('📬 개인정보가 포함되어 있어 1:1 대화로 보냈습니다.');
    } catch {
        await ctx.reply('⚠️ 개인정보가 포함된 자료는 1:1 대화로만 보냅니다. 아래 버튼으로 봇과 대화를 먼저 시작한 뒤 다시 눌러주세요.', dmButton(ctx));
    }
}

async function sendCsv(ctx: Ctx, filename: string, buf: Buffer, caption: string) {
    await ctx.replyWithDocument({ source: buf, filename }, { caption });
}

/* ====================== 주차 데이터 ====================== */

async function loadWeek(orgId: number, period?: S.Period) {
    const [all, subs, settings] = await Promise.all([
        listMembers(orgId, MK),
        period ? S.getSubmissions(period.id) : Promise.resolve(new Map() as Awaited<ReturnType<typeof S.getSubmissions>>),
        getSettings(orgId, MK),
    ]);
    // 활동 시간 집계 대상 = 활성 상태이면서 대원 권한이 있는 사람
    const members = all.filter((m) => m.perms.includes('member'));
    return { members, subs, min: Number(settings.min_minutes) || T.DEFAULT_MIN_MINUTES };
}

const weeklyMinutes = (days?: S.WeekDays) => (days ? T.WEEKDAYS.reduce((sum, w) => sum + (days[w]?.unavailable ? 0 : T.totalMinutes(days[w]?.slots || [])), 0) : 0);

function renderPersonWeek(ws: string, days: S.WeekDays | undefined, min: number): string {
    const lines = T.WEEKDAYS.map((w) => {
        const d = days?.[w];
        const st = T.dayStatus(d, min);
        const label = `${T.DAY_NAMES[w]} ${dateOf(ws, w).format('M/D')}`;
        if (!d || st === 'unavailable' || st === 'missing') return `• ${label}: ${T.STATUS_LABEL[st]}`;
        return `• ${label}: ${d.slots.map(T.fmtSlot).join(', ') || '-'} → <b>${T.fmtHours(T.totalMinutes(d.slots))}</b> ${T.STATUS_LABEL[st]}`;
    });
    lines.push(`주간 활동 가능 시간 합계: <b>${days ? T.fmtHours(weeklyMinutes(days)) : '미제출'}</b>`);
    const short = days ? T.WEEKDAYS.filter((w) => T.dayStatus(days[w], min) === 'short') : [];
    if (short.length) lines.push(`⚠️ 기준(${T.fmtHours(min)}) 미달 요일: ${short.map((w) => T.DAY_NAMES[w]).join(', ')}`);
    return lines.join('\n');
}

// 인자에서 날짜·요일 추출 → 해당 주차 (없으면 최신 주차)
async function pickPeriod(a: A, args: string) {
    const date = parseFlexibleDate(args);
    const dayMatch = args.replace(/\d{1,2}\s*[월일]/g, '').match(/(?:^|\s)([월화수목금토일])(?:요일)?(?=\s|$)/);
    const day = dayMatch ? T.DAY_NAMES.indexOf(dayMatch[1]) : 0;
    const period = date ? await S.getPeriodByWeek(a.org.id, weekStartOf(date)) : await S.getLatestPeriod(a.org.id);
    return { period, day, date };
}

/* ====================== 메뉴 · 권한 ====================== */

type Action = { label?: string; need: Need; place?: Place; run: (ctx: Ctx, a: A, args: string) => Promise<unknown> };

// 등록된 특전대 단체방이면 사용자를 그 조직 대원으로 자동 등록한 뒤 권한 확인
async function access(ctx: Ctx): Promise<Access> {
    if (!inPrivate(ctx) && ctx.chat && ctx.from) {
        const orgId = await getGroupOrg(ctx.chat.id, MK);
        if (orgId) {
            const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || String(ctx.from.id);
            const user = await upsertUser(ctx.from.id, name);
            if (await autoEnroll(orgId, user.id, MK, name)) await audit(orgId, user.id, 'member.auto_enroll', ctx.chat.id);
            const s = await session(ctx);
            s.org = { ...(s.org || {}), [MK]: orgId };
        }
    }
    return resolveAccess(ctx, MK);
}

const ACTIONS: Record<string, Action> = {
    제출: { label: '📝 활동 시간 제출', need: 'member', run: startAvail },
    내현황: { label: '📊 내 활동 현황', need: 'member', run: myStatus },
    결과: { label: '✍️ 오늘 결과 제출', need: 'member', run: (ctx, a) => startResult(ctx, a) },
    내결과: { label: '📄 내 결과 확인', need: 'member', run: myResults },
    시간표: { label: '🗓 전체 활동 시간표', need: 'manager', run: timetable },
    오늘현황: { label: '📈 오늘 전체 현황', need: 'manager', run: todayReport },
    개인현황: { label: '👥 개인별 활동 및 결과', need: 'manager', run: personal },
    결과검색: { label: '🔎 결과 검색', need: 'manager', run: search },
    미제출: { label: '⏳ 미제출자 확인', need: 'manager', run: unsubmitted },
    부족시간: { label: '⚠️ 부족 시간 확인', need: 'manager', run: shortage },
    도움말: { label: '❓ 도움말', need: null, run: help },
    마감: { label: '🔒 제출 마감', need: 'manager', run: closePeriod },
    재개방: { label: '🔓 제출 재개방', need: 'manager', run: reopenPeriod },
    주차시작: { label: '🆕 새 주차 시작', need: 'manager', run: startPeriod },
    대원: { label: '🧑‍🤝‍🧑 인원·역할 관리', need: 'manager', run: memberList },
    승인: { label: '🙋 가입 승인', need: 'manager', run: pendingList },
    수정허용: { need: 'manager', run: allowEdit },
    결과수정: { need: 'manager', run: (ctx, a, args) => editResult(ctx, a, Number(args)) },
    등록: { need: 'manager', run: registerMember },
    활성: { need: 'manager', run: (ctx, a, args) => setStatus(ctx, a, args, 'active') },
    비활성: { need: 'manager', run: (ctx, a, args) => setStatus(ctx, a, args, 'inactive') },
    이름: { need: 'manager', run: rename },
    옵션: { need: 'manager', run: options },
    권한: { need: 'sysadmin', run: setPerms },
    기준: { need: 'sysadmin', run: setMin },
    보관기간: { need: 'sysadmin', run: setRetention },
    조직: { need: null, run: (ctx, a) => askOrg(ctx, MK, a) },
    방등록: { need: 'manager', place: 'group', run: registerGroup },
    방해제: { need: 'manager', place: 'group', run: unregisterGroup },
    현황판: { need: 'manager', place: 'group', run: setBoard },
};

async function dispatch(ctx: Ctx, sub = '', args = '') {
    const a = await access(ctx);
    const s = await session(ctx);
    delete s.flow; // 다른 메뉴로 이동하면 진행 중인 입력은 취소
    s.current = MK;
    if (sub === '가입') return join(ctx, a, args);
    if (!a.org) return a.orgChoices.length > 1 ? askOrg(ctx, MK, a) : joinScreen(ctx, a);
    const action = sub ? ACTIONS[sub] : undefined;
    if (sub && !action) return void (await ctx.reply(`❓ 알 수 없는 명령: ${sub}\n/특전대 도움말 로 사용법을 확인하세요.`));
    if (!action) return menu(ctx, a as A);
    if (!hasPerm(a, action.need)) {
        if (!a.sysadmin && a.membership?.status !== 'active') return joinScreen(ctx, a);
        return void (await ctx.reply('⛔ 이 기능을 사용할 권한이 없습니다.'));
    }
    if (await wrongPlace(ctx, action)) return;
    await action.run(ctx, a as A, args.trim());
}

async function menu(ctx: Ctx, a: A) {
    if (!a.sysadmin && a.membership?.status !== 'active') return joinScreen(ctx, a);
    const p = await S.getLatestPeriod(a.org.id);
    const role = a.sysadmin ? '시스템 관리자' : a.membership!.perms.map((x) => PERM_LABEL[x]).join(' · ');
    const items = Object.entries(ACTIONS).filter(([, x]) => x.label && hasPerm(a, x.need) && placeOk(ctx, x));
    // 이 장소에서 못 쓰는 내 기능이 있으면 어디서 쓰는지 안내
    const elsewhere = Object.values(ACTIONS).some((x) => x.label && hasPerm(a, x.need) && !placeOk(ctx, x));
    const note = !elsewhere ? '' : inPrivate(ctx) ? `\n\n${MSG_GO_GROUP}` : `\n\n${MSG_GO_DM}`;
    const buttons = chunk(
        items.map(([k, x]) => btn(x.label!, `sd:a:${k}`)),
        2
    );
    if (a.orgChoices.length > 1) buttons.push([btn('🏢 조직 변경', 'sd:a:조직')]);
    await show(
        ctx,
        `🪖 <b>${NAME}</b> · ${e(a.org.name)}\n👤 ${e(a.membership?.display_name || ctx.from.first_name)} (${role})\n` +
            `🗓 취합 주차: ${p ? `${weekLabel(p.week_start)} (${p.status === 'open' ? '제출 받는 중' : '마감'})` : '아직 없음'}` +
            note,
        buttons
    );
}

async function joinScreen(ctx: Ctx, a: Access) {
    const m = a.membership ?? a.memberships[0];
    if (m?.status === 'pending') return void (await ctx.reply('⏳ 가입 요청이 접수되어 관리자 승인을 기다리고 있습니다.'));
    if (m?.status === 'inactive') return void (await ctx.reply('🚫 비활성화된 계정입니다. 관리자에게 문의해주세요.'));
    const orgs = await listOrgs();
    await ctx.reply(
        `🪖 아직 ${NAME} 대원으로 등록되어 있지 않습니다.\n가입 요청 후 관리자 승인을 받으면 이용할 수 있습니다.\n` +
            `이름을 함께 보내려면: <code>/특전대 가입 홍길동</code>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard(orgs.map((o) => [btn(`🙋 가입 요청 — ${o.name}`, `sd:jo:${o.id}`)])) }
    );
}

async function join(ctx: Ctx, a: Access, name: string) {
    if (a.membership?.status === 'active') return void (await ctx.reply('✅ 이미 등록된 대원입니다. /특전대 로 메뉴를 열어주세요.'));
    if (name) (await session(ctx)).joinName = name.slice(0, 30);
    await joinScreen(ctx, a);
}

async function doJoin(ctx: Ctx, orgId: number) {
    const orgs = await listOrgs();
    const org = orgs.find((o) => o.id === orgId);
    if (!org) return;
    const a = await access(ctx);
    const s = await session(ctx);
    const name = s.joinName || [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || String(ctx.from.id);
    const before = a.memberships.find((m) => m.org_id === orgId);
    if (before?.status === 'active') return show(ctx, '✅ 이미 등록된 대원입니다.');
    const m = await upsertMembership(orgId, a.userId, MK, name, 'pending');
    delete s.joinName;
    if (m.status !== 'pending') return show(ctx, '🚫 가입할 수 없는 상태입니다. 관리자에게 문의해주세요.');
    await audit(orgId, a.userId, 'member.join_request', m.id);
    await notifyManagers(ctx.telegram, orgId, MK, `🙋 <b>[${NAME} 가입 요청]</b> ${e(org.name)}\n${e(name)} (ID <code>${ctx.from.id}</code>)`, {
        ...Markup.inlineKeyboard([[btn('✅ 승인', `sd:ap:${orgId}-${m.id}`), btn('❌ 거절', `sd:rj:${orgId}-${m.id}`)]]),
    });
    // 승인 버튼은 관리자 1:1 대화로만 (notifyManagers). 알림을 못 받은 관리자는 1:1 대화에서 /특전대 승인
    await show(ctx, `📨 [${e(org.name)}] ${e(name)} 님 가입 요청을 보냈습니다. 관리자 승인 후 /특전대 로 이용할 수 있습니다.`);
}

// 다른 조직의 요청에 대한 버튼일 수 있으므로 그 조직 기준으로 권한 재확인
function accessIn(a: Access, orgId: number): A | undefined {
    const org = a.orgChoices.find((o) => o.id === orgId);
    return org ? { ...a, org, membership: a.memberships.find((m) => m.org_id === orgId) } : undefined;
}

async function decideJoin(ctx: Ctx, a: Access, arg: string, approve: boolean) {
    const [orgId, mid] = arg.split('-').map(Number);
    const scoped = accessIn(a, orgId);
    if (!scoped || !hasPerm(scoped, 'manager')) return void (await ctx.reply('⛔ 권한이 없습니다.'));
    const m = await getMember(orgId, MK, { id: mid });
    if (!m) return show(ctx, '⚠️ 요청을 찾을 수 없습니다.');
    if (m.status !== 'pending') return show(ctx, `ℹ️ 이미 처리된 요청입니다 (${e(m.display_name)}: ${m.status}).`);
    await updateMembership(orgId, mid, { status: approve ? 'active' : 'rejected' });
    await audit(orgId, a.userId, approve ? 'member.approve' : 'member.reject', mid);
    await ctx.telegram
        .sendMessage(m.telegram_id, approve ? `🎉 ${NAME} 가입이 승인되었습니다. /특전대 로 시작하세요.` : `${NAME} 가입 요청이 거절되었습니다. 관리자에게 문의해주세요.`)
        .catch(() => {});
    await show(ctx, `${approve ? '✅ 승인' : '❌ 거절'}: ${e(m.display_name)} (ID <code>${m.telegram_id}</code>)`);
}

/* ====================== 활동 가능 시간 제출 ====================== */

const WEEK_EXAMPLE = '월/12-14,18-20\n화/15-18,19-21\n수/불가\n목/11-19\n금/11-20\n토/10-20';

// '/활동시간' 만 보내면 양식 안내
async function startAvail(ctx: Ctx, a: A) {
    const p = await S.getEditablePeriod(a.org.id, a.userId);
    if (!p) return void (await ctx.reply('⏳ 지금은 활동 시간을 받는 주차가 없습니다 (마감되었거나 시작 전). 관리자에게 문의해주세요.'));
    await show(
        ctx,
        `📝 <b>${weekLabel(p.week_start)} 활동 시간</b>\n아래처럼 <b>/활동시간</b> 밑에 한 줄에 한 요일씩 적어 보내주세요 (시간 여러 개는 쉼표, 못 하는 날은 불가):\n\n<code>/활동시간\n${WEEK_EXAMPLE}</code>\n\n처음 제출이면 안 적은 요일은 활동 불가, 이미 제출했다면 적은 요일만 바뀝니다.`
    );
}

async function myStatus(ctx: Ctx, a: A) {
    const p = (await S.getEditablePeriod(a.org.id, a.userId)) ?? (await S.getLatestPeriod(a.org.id));
    const wsNow = weekStartOf(today());
    const [{ subs, min }, results] = await Promise.all([
        loadWeek(a.org.id, p),
        S.listResults(a.org.id, { userId: a.userId, from: wsNow, to: dayjs(wsNow).add(6, 'day').format('YYYY-MM-DD') }),
    ]);
    const mine = p ? subs.get(a.userId) : undefined;
    let html = `📊 <b>내 활동 현황</b>\n`;
    html += p
        ? `\n<b>[활동 가능 시간] ${weekLabel(p.week_start)}</b> (${p.status === 'open' ? '제출 받는 중' : '마감'})\n${renderPersonWeek(p.week_start, mine?.days, min)}\n`
        : '\n아직 취합 주차가 없습니다.\n';
    html += `\n<b>[당일 결과]</b> (활동 가능 시간과 별도 집계)\n• 오늘: ${results.filter((r) => r.activity_date === today()).length}건\n• 이번 주: ${results.length}건`;
    await show(ctx, html, [[btn('📝 활동 시간 제출/수정', 'sd:a:제출'), btn('📄 내 결과', 'sd:a:내결과')]]);
}

/* ====================== 당일 결과 제출 ====================== */

interface ResultFlow {
    kind: 'result';
    chatId: number;
    orgId: number;
    date: string;
    values: R.ResultValues;
    queue: R.FieldKey[];
    form?: R.FormKind; // 발굴건 / 찾기건 (단계별 입력은 먼저 고름)
    dedupKey: string;
    editId?: number;
    opts?: string[];
}

const HINTS: Partial<Record<R.FieldKey, string>> = {
    phone: '\n예: 뒷자리 <code>5678</code> (전체 번호도 됨)',
    birth_date: '\n예: <code>990315</code>',
    meet_at: '\n예: <code>10.28 19시</code>',
    meet_place: '\n예: <code>강남역 카페</code>',
    target_month: '\n예: <code>11월</code>',
};
const formFields = (f: { form?: R.FormKind }) => (f.form ? R.FORMS[f.form].fields : []);
const FORM_GUIDE = `<code>${R.FORMS.dig.template}</code>\n<code>${R.FORMS.find.template}</code>`;

async function startResult(ctx: Ctx, a: A, init?: R.ParsedForm & { dedupKey: string }) {
    const values = init?.values ?? {};
    const f: ResultFlow = {
        kind: 'result',
        chatId: ctx.chat.id,
        orgId: a.org.id,
        date: today(),
        form: init?.kind,
        values,
        queue: init ? R.FORMS[init.kind].fields.filter((k) => values[k] === undefined) : [],
        dedupKey: init?.dedupKey ?? `f:${a.userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    };
    (await session(ctx)).flow = f;
    if (init) {
        const got = formFields(f).filter((k) => values[k]).map((k) => `• ${R.fieldLabel(k)}: ${e(values[k])}`);
        await ctx.reply(
            `🧾 <b>자동 정리 결과 — ${R.FORMS[init.kind].label}</b>\n${got.join('\n') || '(인식된 값 없음)'}` +
                (init.notes.length ? `\n\n${init.notes.map((n) => `⚠️ ${e(n)}`).join('\n')}` : '') +
                (f.queue.length ? `\n\n빠졌거나 확인이 필요한 항목만 이어서 여쭤볼게요: ${f.queue.map(R.fieldLabel).join(', ')}` : ''),
            { parse_mode: 'HTML' }
        );
    }
    await askNext(ctx, f);
}

async function askNext(ctx: Ctx, f: ResultFlow) {
    if (!f.form)
        return show(ctx, `✍️ <b>오늘 결과 제출</b>\n어떤 결과인가요?\n\n양식을 한 줄로 올려도 됩니다:\n${FORM_GUIDE}`, [
            [btn('🔍 발굴건', 'sd:rs:form:dig'), btn('🧭 찾기건', 'sd:rs:form:find')],
            [btn('✖ 취소', 'sd:rs:cx')],
        ]);
    const k = f.queue[0];
    if (!k) return resultReview(ctx, f);
    const opts = k === 'age_group' ? R.AGE_GROUPS : R.OPTION_FIELDS.includes(k) ? (await S.listOptions(f.orgId))[k] || [] : [];
    f.opts = opts;
    const free = k !== 'age_group' && !(k === 'gender' && opts.length);
    const fields = formFields(f);
    await show(
        ctx,
        `✍️ <b>${f.editId ? `결과 #${f.editId} 수정` : '오늘 결과 제출'} — ${R.FORMS[f.form].label}</b> [${fields.indexOf(k) + 1}/${fields.length}]\n` +
            `<b>${R.fieldLabel(k)}</b>을(를) ${opts.length ? (free ? '선택하거나 직접 입력해주세요.' : '선택해주세요.') : '입력해주세요.'}${HINTS[k] || ''}`,
        [
            ...chunk(
                opts.map((o, i) => btn(o.slice(0, 30), `sd:rs:pick:${i}`)),
                3
            ),
            [btn('⏭ 미입력으로 두기', 'sd:rs:skip'), btn('✖ 취소', 'sd:rs:cx')],
        ]
    );
}

async function setField(ctx: Ctx, f: ResultFlow, raw: string) {
    const k = f.queue[0];
    if (!k) return askNext(ctx, f);
    const r = R.validateField(k, raw, f.opts || []);
    if (!r.ok) {
        await ctx.reply(`⚠️ ${r.reason}`);
        return askNext(ctx, f);
    }
    f.values[k] = r.value;
    f.queue.shift();
    await askNext(ctx, f);
}

// hidePii: 단체방에서는 이름 가림, 연락처·생년월일 숨김
const piiCell = (k: R.FieldKey, v: string, hidePii: boolean) => (!hidePii || !R.PII_FIELDS.includes(k) ? e(v) : k === 'name' ? e(R.maskName(v)) : '🔒');
const resultDetail = (v: R.ResultValues, form: R.FormKind, hidePii = false) =>
    R.FORMS[form].fields.map((k, i) => `${i + 1}. ${R.fieldLabel(k)}: ${v[k] ? piiCell(k, v[k]!, hidePii) : '<i>(미입력)</i>'}`).join('\n');

async function resultReview(ctx: Ctx, f: ResultFlow) {
    await show(
        ctx,
        `🧾 <b>${f.editId ? `결과 #${f.editId} 수정 확인` : '결과 확인'} — ${R.FORMS[f.form!].label}</b> (활동일 ${f.date})\n\n${resultDetail(f.values, f.form!)}\n\n맞으면 <b>저장</b>을 눌러주세요.`,
        [[btn('✅ 저장', 'sd:rs:ok'), btn('✏️ 항목 수정', 'sd:rs:ed')], [btn('✖ 취소', 'sd:rs:cx')]]
    );
}

// 본인 결과이거나, 팀 관리자 + 개인정보 조회 권한이 있을 때만 다른 사람 결과 열람·수정
const canTouchResult = (a: A, row: S.ResultRow) => row.user_id === a.userId || (hasPerm(a, 'manager') && hasPerm(a, 'pii'));

async function saveResult(ctx: Ctx, a: A, s: Record<string, any>, f: ResultFlow) {
    if (!f.form) return askNext(ctx, f);
    let id: number | null;
    if (f.editId) {
        const row = await S.getResult(f.orgId, f.editId);
        if (!row || !canTouchResult(a, row)) return show(ctx, '⛔ 수정할 수 없는 결과입니다.');
        await S.updateResult(f.orgId, f.editId, f.values);
        // 감사 로그에는 개인정보 값 대신 바뀐 항목 이름만 남김
        await audit(f.orgId, a.userId, 'result.update', f.editId, { changed: formFields(f).filter((k) => (row[k] ?? null) !== (f.values[k] ?? null)) });
        id = f.editId;
    } else {
        if (!hasPerm(a, 'member')) return show(ctx, '⛔ 권한이 없습니다.');
        id = await S.insertResult({ orgId: f.orgId, userId: a.userId, kind: f.form, date: f.date, values: f.values, dedupKey: f.dedupKey });
        if (!id) {
            delete s.flow;
            return show(ctx, 'ℹ️ 이미 저장된 결과입니다. (중복 저장 방지)');
        }
        await audit(f.orgId, a.userId, 'result.create', id, { kind: f.form });
    }
    delete s.flow;
    await touchBoard(ctx, f.orgId);
    await show(ctx, `✅ ${R.FORMS[f.form].label} 결과 #${id} ${f.editId ? '수정' : '저장'} 완료`, [[btn('➕ 결과 추가 입력', 'sd:a:결과'), btn('📄 내 결과', 'sd:a:내결과')]]);
}

async function editResult(ctx: Ctx, a: A, id: number) {
    const row = id ? await S.getResult(a.org.id, id) : undefined;
    if (!row) return void (await ctx.reply('⚠️ 결과를 찾을 수 없습니다. 예: /특전대 결과수정 12'));
    if (!canTouchResult(a, row)) return void (await ctx.reply('⛔ 이 결과를 수정할 권한이 없습니다.'));
    const f: ResultFlow = {
        kind: 'result',
        chatId: ctx.chat.id,
        orgId: a.org.id,
        date: row.activity_date,
        form: row.kind,
        values: Object.fromEntries(R.FIELD_KEYS.map((k) => [k, row[k]])),
        queue: [],
        dedupKey: `edit:${id}`,
        editId: id,
    };
    (await session(ctx)).flow = f;
    await resultReview(ctx, f);
}

async function resultCb(ctx: Ctx, a: A, s: Record<string, any>, arg: string) {
    const [cmd, v = ''] = arg.split(':');
    if (['view', 'edit', 'del', 'delok'].includes(cmd)) {
        const row = await S.getResult(a.org.id, Number(v));
        if (!row || !canTouchResult(a, row)) return show(ctx, '⚠️ 결과를 찾을 수 없거나 권한이 없습니다.');
        if (cmd === 'edit') return editResult(ctx, a, row.id);
        if (cmd === 'del')
            return show(ctx, `🗑 결과 #${row.id} 을(를) 삭제할까요?`, [[btn('삭제', `sd:rs:delok:${row.id}`), btn('취소', `sd:rs:view:${row.id}`)]]);
        if (cmd === 'delok') {
            await S.deleteResult(a.org.id, row.id);
            await touchBoard(ctx, a.org.id);
            await audit(a.org.id, a.userId, 'result.delete', row.id);
            return show(ctx, `🗑 결과 #${row.id} 삭제 완료`, [[btn('📄 내 결과', 'sd:a:내결과')]]);
        }
        return show(
            ctx,
            `📄 <b>${R.FORMS[row.kind].label} #${row.id}</b> (활동일 ${row.activity_date})\n제출: ${e(row.submitter)} · ${row.created_at}${row.updated_at !== row.created_at ? ` (수정 ${row.updated_at})` : ''}\n\n${resultDetail(row, row.kind, !inPrivate(ctx))}`,
            [[btn('✏️ 수정', `sd:rs:edit:${row.id}`), btn('🗑 삭제', `sd:rs:del:${row.id}`)]]
        );
    }
    const f: ResultFlow | undefined = s.flow;
    if (f?.kind !== 'result' || f.orgId !== a.org.id) return show(ctx, '⌛ 진행 중인 입력이 없습니다. /특전대 에서 다시 시작해주세요.');
    switch (cmd) {
        case 'form':
            if (!f.form && (v === 'dig' || v === 'find')) {
                f.form = v;
                f.queue = [...R.FORMS[v].fields];
            }
            return askNext(ctx, f);
        case 'pick':
            return f.opts?.[Number(v)] !== undefined ? setField(ctx, f, f.opts[Number(v)]) : askNext(ctx, f);
        case 'skip':
            if (f.queue[0]) f.values[f.queue.shift()!] = null;
            return askNext(ctx, f);
        case 'ed':
            return show(ctx, '✏️ 수정할 항목을 선택하세요.', [
                ...chunk(
                    formFields(f).map((k) => btn(R.fieldLabel(k), `sd:rs:fx:${k}`)),
                    3
                ),
                [btn('◀ 돌아가기', 'sd:rs:back')],
            ]);
        case 'fx':
            if (formFields(f).includes(v as R.FieldKey)) f.queue = [v as R.FieldKey];
            return askNext(ctx, f);
        case 'ok':
            return saveResult(ctx, a, s, f);
        case 'cx':
            delete s.flow;
            return show(ctx, '✖ 결과 입력을 취소했습니다.');
    }
    await askNext(ctx, f);
}

// 단체방에 '/활동시간' + 요일별 줄 → 처음이면 저장, 이미 냈으면 적은 요일만 수정
async function handleWeekText(ctx: Ctx, text: string) {
    if (inPrivate(ctx)) return void (await ctx.reply(MSG_GO_GROUP));
    const a = await access(ctx);
    if (!a.org || !hasPerm(a, 'member')) return void (await ctx.reply('🪖 활동 시간을 제출하려면 먼저 특전대 대원 등록이 필요합니다. /특전대 를 눌러주세요.'));
    const parsed = T.parseWeekText(text);
    if (!parsed || parsed.errors.length) return void (await ctx.reply(`⚠️ ${parsed?.errors.join('\n') || '요일/시간 형식으로 적어주세요.'}\n\n예:\n/활동시간\n${WEEK_EXAMPLE}`));
    const p = await S.getEditablePeriod(a.org.id, a.userId);
    if (!p) return void (await ctx.reply('⏳ 지금은 활동 시간을 받는 주차가 없습니다 (마감되었거나 시작 전). 관리자에게 문의해주세요.'));
    const [existing, settings] = await Promise.all([S.getSubmissions(p.id).then((m) => m.get(a.userId)), getSettings(a.org.id, MK)]);
    const days: S.WeekDays = Object.fromEntries(T.WEEKDAYS.map((w) => [w, parsed.days[w] ?? existing?.days[w] ?? { unavailable: true, slots: [] }]));
    await S.saveSubmission(p.id, a.userId, days);
    await touchBoard(ctx, a.org.id);
    await audit(a.org.id, a.userId, existing ? 'avail.update' : 'avail.submit', p.id, days);
    const untouched = T.WEEKDAYS.filter((w) => !parsed.days[w]);
    const note = untouched.length ? `\n\nℹ️ 안 적은 요일(${untouched.map((w) => T.DAY_NAMES[w]).join(', ')}): ${existing ? '기존 제출 그대로' : '활동 불가로 저장'}` : '';
    await show(ctx, `✅ <b>활동 가능 시간 ${existing ? '수정' : '제출'} 완료</b> (${weekLabel(p.week_start)})\n\n${renderPersonWeek(p.week_start, days, Number(settings.min_minutes) || T.DEFAULT_MIN_MINUTES)}${note}`);
}

// 단체방에 '발/…' 또는 '찾/…' 양식. 한 건이면 자동 정리 후 빠지거나 틀린 칸만 질문, 여러 건이면 바로 저장
async function handleFreeForm(ctx: Ctx, text: string): Promise<boolean> {
    const forms = R.parseSlashForms(text);
    if (!forms.length) return false;
    if (inPrivate(ctx)) {
        await ctx.reply('👥 결과는 특전대 단체방에 올려주세요.');
        return true;
    }
    const a = await access(ctx);
    if (!a.org || !hasPerm(a, 'member')) {
        await ctx.reply('🪖 결과를 제출하려면 먼저 특전대 대원 등록이 필요합니다. /특전대 를 눌러 가입 요청해주세요.');
        return true;
    }
    const opts = await S.listOptions(a.org.id);
    // 칸별 검증. 여러 건을 한 번에 올리면 다시 묻지 않으므로 형식이 안 맞는 값도 입력 그대로 두고 확인 필요로 표시
    const clean = (form: R.ParsedForm, keepRaw: boolean) => {
        const values: R.ResultValues = {};
        const notes = [...form.notes];
        for (const k of R.FORMS[form.kind].fields) {
            const raw = form.values[k];
            if (!raw) continue;
            const r = R.validateField(k, raw, k === 'age_group' ? [] : opts[k] || []);
            if (r.ok) values[k] = r.value;
            else {
                notes.push(keepRaw ? `${R.fieldLabel(k)} 형식 확인` : `${R.fieldLabel(k)}: ${r.reason}`);
                if (keepRaw) values[k] = raw;
            }
        }
        return { kind: form.kind, values, notes };
    };
    const who = (kind: R.FormKind, v: R.ResultValues) => {
        const all = (kind === 'dig' ? v.phone : v.birth_date)?.replace(/\D/g, '');
        const digits = kind === 'dig' ? all?.slice(-4) : all; // 연락처는 뒷자리 4자리로 비교
        return v.name && digits ? { name: v.name, digits } : null;
    };
    const base = `m:${ctx.chat.id}:${ctx.message.message_id}`;

    if (forms.length === 1) {
        if (await S.resultExists(base)) {
            await ctx.reply('ℹ️ 이 메시지는 이미 저장되었습니다.');
            return true;
        }
        const one = clean(forms[0], false);
        const p = who(one.kind, forms[0].values); // 형식이 틀린 값도 입력 그대로 비교
        if (p && (await S.isDuplicateResult(a.org.id, one.kind, p.name, p.digits))) {
            await ctx.reply(`⏭ 이미 등록된 ${R.FORMS[one.kind].label}입니다 (${one.kind === 'dig' ? '이름·연락처 뒷자리' : '이름·생년월일'} 같음). 저장하지 않았습니다.`);
            return true;
        }
        await startResult(ctx, a as A, { ...one, dedupKey: base });
        return true;
    }

    // 여러 건: 줄마다 바로 저장, 이미 있는 사람(또는 같은 메시지 안 중복)은 빼고
    const saved: string[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (const [i, form] of forms.entries()) {
        const one = clean(form, true);
        const p = who(one.kind, form.values);
        const label = `${i + 1}번째 줄 ${e(R.maskName(one.values.name) || '(이름 없음)')}`;
        const key = p && `${one.kind}|${p.name}|${p.digits}`;
        if ((key && seen.has(key)) || (p && (await S.isDuplicateResult(a.org.id, one.kind, p.name, p.digits)))) {
            skipped.push(label);
            continue;
        }
        if (key) seen.add(key);
        const id = await S.insertResult({ orgId: a.org.id, userId: a.userId, kind: one.kind, date: today(), values: one.values, dedupKey: `${base}:${i}` });
        if (!id) continue; // 같은 메시지가 다시 들어온 경우
        await audit(a.org.id, a.userId, 'result.create', id, { kind: one.kind, bulk: true });
        const empty = R.missingCount({ kind: one.kind, ...one.values });
        const extra = [...one.notes, ...(empty ? [`빈 칸 ${empty}개`] : [])];
        saved.push(`#${id} ${R.FORMS[one.kind].label} ${label}${extra.length ? ` — ⚠️ ${e(extra.join(', '))}` : ''}`);
    }
    if (saved.length) await touchBoard(ctx, a.org.id);
    await ctx.reply(
        `✅ <b>결과 ${saved.length}건 저장</b>${saved.length ? `\n${saved.join('\n')}` : ''}` +
            (skipped.length ? `\n\n⏭ <b>중복 제외 ${skipped.length}건</b> (이미 등록된 사람)\n${skipped.join('\n')}` : '') +
            (saved.some((x) => x.includes('⚠️')) ? '\n\n빈 칸·형식 확인은 <code>/특전대 내결과</code> 에서 고칠 수 있습니다.' : ''),
        { parse_mode: 'HTML' }
    );
    return true;
}

function resultLine(r: S.ResultRow, pii: boolean) {
    const v = (k: R.FieldKey) => (r[k] ? piiCell(k, r[k]!, !pii) : '-');
    const head = `#${r.id} ${r.activity_date.slice(5)} [${r.submitter ? e(r.submitter) : '-'}]`;
    return r.kind === 'find'
        ? `${head} 찾기 · ${v('name')} · ${v('birth_date')} · ${v('region')}/${v('team')}/${v('guide')} · 목표 ${v('target_month')}`
        : `${head} 발굴 · ${v('name')} · ${v('phone')} · ${v('age_group')} · ${v('gender')} · ${v('region')}/${v('team')}/${v('guide')} · ${v('tool')} · 2차 ${v('meet_at')} ${v('meet_place')}`;
}

async function myResults(ctx: Ctx, a: A) {
    const rows = (await S.listResults(a.org.id, { userId: a.userId, from: dayjs(today()).subtract(6, 'day').format('YYYY-MM-DD') })).slice(0, 30);
    if (!rows.length) return show(ctx, '📄 최근 7일간 제출한 결과가 없습니다.', [[btn('✍️ 오늘 결과 제출', 'sd:a:결과')]]);
    await show(ctx, `📄 <b>내 결과</b> (최근 7일 · ${rows.length}건)\n\n${rows.map((r) => resultLine(r, inPrivate(ctx))).join('\n')}\n\n번호를 눌러 상세 확인·수정·삭제`, [
        ...chunk(
            rows.map((r) => btn(`#${r.id}`, `sd:rs:view:${r.id}`)),
            5
        ),
    ]);
}

/* ====================== 보고서 ====================== */

async function timetable(ctx: Ctx, a: A, args: string) {
    const { period, day } = await pickPeriod(a, args);
    if (!period) return void (await ctx.reply('⚠️ 해당 주차가 없습니다. /특전대 주차시작 으로 먼저 주차를 시작해주세요.'));
    await sendTimetable(ctx, a, period, day);
}

function weekTable(members: Membership[], subs: Awaited<ReturnType<typeof S.getSubmissions>>, min: number, w: number) {
    const people = members.map((m) => {
        const d = subs.get(m.user_id)?.days[w];
        const slots = d && !d.unavailable ? d.slots : [];
        return { name: m.display_name, status: T.dayStatus(d, min), minutes: T.totalMinutes(slots), slots };
    });
    return { people, segments: T.buildTimetable(people.filter((p) => p.slots.length)) };
}

async function sendTimetable(ctx: Ctx, a: A, period: S.Period, day: number) {
    const { members, subs, min } = await loadWeek(a.org.id, period);
    const now = nowKst().format('YYYY-MM-DD HH:mm');
    const submitted = members.filter((m) => subs.has(m.user_id)).length;
    const snapshot: Record<string, unknown> = { week_start: period.week_start, generated_at: now, min, days: {} };
    let html =
        `🗓 <b>[${NAME} 활동 시간표]</b> ${weekLabel(period.week_start)} 주차 (${period.status === 'open' ? '제출 받는 중' : '마감'})\n` +
        `생성 시각: ${now} · 하루 기준 ${T.fmtHours(min)}\n대원 ${members.length}명 · 제출 ${submitted}명 · 미제출 ${members.length - submitted}명\n`;
    for (const w of day ? [day] : T.WEEKDAYS) {
        const { people, segments } = weekTable(members, subs, min, w);
        html += `\n━━━━━━━━━━━━━━\n<b>[${T.DAY_NAMES[w]} ${dateOf(period.week_start, w).format('M/D')}]</b>\n`;
        html += segments.length ? segments.map((sg) => `${T.fmtSlot([sg.start, sg.end])} (${sg.names.length}명) ${sg.names.map(e).join(', ')}`).join('\n') : '제출된 시간이 없습니다.';
        const listed = people.filter((p) => p.status !== 'missing');
        if (listed.length)
            html += `\n<b>개인별</b>\n${listed.map((p) => `• ${e(p.name)}: ${p.status === 'unavailable' ? T.STATUS_LABEL.unavailable : `${T.fmtHours(p.minutes)} ${T.STATUS_LABEL[p.status]}`}`).join('\n')}`;
        const short = people.filter((p) => p.status === 'short');
        const missing = people.filter((p) => p.status === 'missing');
        if (short.length) html += `\n⚠️ 부족: ${short.map((p) => e(p.name)).join(', ')}`;
        if (missing.length) html += `\n⏳ 미제출: ${missing.map((p) => e(p.name)).join(', ')}`;
        html += '\n';
        (snapshot.days as any)[w] = { segments, people: people.map(({ name, status, minutes }) => ({ name, status, minutes })) };
    }
    await S.saveSnapshot(period.id, a.userId, snapshot);
    await show(ctx, html, [
        T.WEEKDAYS.map((w) => btn(T.DAY_NAMES[w], `sd:tt:${period.id}-${w}`)),
        [btn('전체', `sd:tt:${period.id}-0`)],
        [btn('📥 CSV 내보내기', `sd:tc:${period.id}`)],
    ]);
}

async function timetableCsv(ctx: Ctx, a: A, period: S.Period) {
    const { members, subs, min } = await loadWeek(a.org.id, period);
    const segRows: (string | number)[][] = [];
    for (const w of T.WEEKDAYS) {
        for (const sg of weekTable(members, subs, min, w).segments) {
            segRows.push([T.DAY_NAMES[w], dateOf(period.week_start, w).format('YYYY-MM-DD'), T.fmtClock(sg.start), T.fmtClock(sg.end), sg.names.length, sg.names.join(', ')]);
        }
    }
    const personRows = members.map((m) => {
        const days = subs.get(m.user_id)?.days;
        return [
            m.display_name,
            ...T.WEEKDAYS.flatMap((w) => {
                const st = T.dayStatus(days?.[w], min);
                return [st === 'ok' || st === 'short' ? T.totalMinutes(days![w].slots) / 60 : '', T.STATUS_LABEL[st].replace(/^\S+\s/, '')];
            }),
            days ? weeklyMinutes(days) / 60 : '',
        ];
    });
    const tag = `${period.week_start}_${nowKst().format('MMDD-HHmm')}`;
    await sendCsv(ctx, `timetable_${tag}.csv`, R.toCsv(['요일', '날짜', '시작', '종료', '인원', '활동 가능 대원'], segRows), `🗓 ${weekLabel(period.week_start)} 시간표`);
    await sendCsv(
        ctx,
        `personal_hours_${tag}.csv`,
        R.toCsv(['대원', ...T.WEEKDAYS.flatMap((w) => [`${T.DAY_NAMES[w]}(시간)`, `${T.DAY_NAMES[w]} 상태`]), '주간 합계(시간)'], personRows),
        '👥 개인별 활동 가능 시간'
    );
}

async function todayReport(ctx: Ctx, a: A, args: string) {
    const date = parseFlexibleDate(args) || today();
    const { html, results } = await todayHtml(a.org.id, date);
    const buttons: Buttons = hasPerm(a, 'pii') && results.length ? [[btn('📇 상세 결과 (개인정보)', `sd:td:${date}`)]] : [];
    await show(ctx, `${html}\n\n<b>6. 당일 항목별 집계</b>\n${resultStats(results)}`, buttons);
}

const kindCount = (rows: S.ResultRow[]) => `발 ${rows.filter((r) => r.kind === 'dig').length}건 · 찾 ${rows.filter((r) => r.kind === 'find').length}건`;

// 대원별 '이름: 발 n건 · 찾 n건' (많은 순)
function perPerson(rows: S.ResultRow[], members: Membership[]) {
    const names = new Map(members.map((m) => [m.user_id, m.display_name]));
    const by = new Map<number, S.ResultRow[]>();
    for (const r of rows) by.set(r.user_id, [...(by.get(r.user_id) || []), r]);
    const lines = [...by.entries()]
        .sort((x, y) => y[1].length - x[1].length)
        .map(([uid, rs]) => `• ${e(names.get(uid) || rs[0].submitter || '?')}: ${kindCount(rs)}`);
    return lines.join('\n') || '• 아직 없습니다.';
}

// 일일 현황 (결과 대상자 이름·연락처 같은 개인정보 없음 → 단체방 현황판에도 사용)
async function todayHtml(orgId: number, date: string) {
    const ws = weekStartOf(date);
    const w = weekdayOf(date);
    const period = await S.getPeriodByWeek(orgId, ws);
    const [{ members, subs, min }, week] = await Promise.all([loadWeek(orgId, period), S.listResults(orgId, { from: ws, to: date })]);
    const results = week.filter((r) => r.activity_date === date);
    const people = weekTable(members, subs, min, w).people;
    const count = (st: T.DayStatus) => people.filter((p) => p.status === st).length;

    let html = `📈 <b>[${NAME} 일일 현황] ${date} (${'일월화수목금토'[dayjs(date).day()]})</b>\n생성 시각: ${nowKst().format('YYYY-MM-DD HH:mm')}\n`;
    html += `\n<b>1. 당일 결과</b> — 총 ${results.length}건 (${kindCount(results)})\n${perPerson(results, members)}`;
    const none = members.filter((m) => !results.some((r) => r.user_id === m.user_id));
    if (results.length && none.length) html += `\n• 0건: ${none.map((m) => e(m.display_name)).join(', ')}`;
    html += `\n\n<b>2. 이번 주 누적</b> (${dayjs(ws).format('M/D')}~${dayjs(date).format('M/D')}) — 총 ${week.length}건 (${kindCount(week)})\n${perPerson(week, members)}`;
    html += `\n\n<b>3. 요일별</b>\n${T.WEEKDAYS.filter((d) => d <= w)
        .map((d) => {
            const ymd = dateOf(ws, d).format('YYYY-MM-DD');
            return `• ${T.DAY_NAMES[d]} ${dateOf(ws, d).format('M/D')}: ${kindCount(week.filter((r) => r.activity_date === ymd))}`;
        })
        .join('\n')}`;
    html += `\n\n<b>4. 활동 가능 시간</b>\n• 등록 대원: ${members.length}명\n`;
    if (!period) html += '• 이 주차는 취합이 시작되지 않았습니다.\n';
    else
        html +=
            `• 제출 완료: ${people.length - count('missing')}명 · 미제출: ${count('missing')}명\n` +
            `• ${T.fmtHours(min)} 충족: ${count('ok')}명 · 미충족: ${count('short')}명 · 활동 불가: ${count('unavailable')}명\n`;
    html += `\n<b>5. 개인별 오늘 가능 시간</b>\n`;
    html += members
        .map((m, i) => {
            const p = people[i];
            const avail = !p ? '-' : p.status === 'missing' || p.status === 'unavailable' ? T.STATUS_LABEL[p.status] : `${T.fmtHours(p.minutes)} ${T.STATUS_LABEL[p.status]}`;
            return `• ${e(m.display_name)}: ${avail}`;
        })
        .join('\n');
    return { html, results };
}

/* ====================== 단체방 현황판 (주제방의 한 메시지를 계속 갱신) ====================== */

type Board = { chatId: number; threadId?: number; date?: string; messageId?: number };

// 결과·활동 시간이 바뀔 때마다 호출. 날짜가 바뀌면 그날 현황판을 새 메시지로 올림
// shortcut: 동시에 두 건이 저장되면 날짜 바뀐 직후 현황판 메시지가 2개 생길 수 있음, 문제 되면 잠금 추가
async function refreshBoard(telegram: Telegraf['telegram'], orgId: number) {
    const b: Board | null = (await getSettings(orgId, MK)).board;
    if (!b) return;
    const date = today();
    let html = `📌 <b>실시간 현황판</b> — 제출될 때마다 자동 갱신\n\n${(await todayHtml(orgId, date)).html}`;
    if (html.length > 4000) html = html.slice(0, 3900) + '\n…(길어서 생략 — 전체는 관리자 /특전대 오늘현황)';
    if (b.messageId && b.date === date) {
        try {
            await telegram.editMessageText(b.chatId, b.messageId, undefined, html, { parse_mode: 'HTML' });
            return;
        } catch (err) {
            if (/not modified/.test(getErrorMessage(err))) return; // 지워졌으면 아래에서 새로 올림
        }
    }
    const m = await telegram.sendMessage(b.chatId, html, { parse_mode: 'HTML', message_thread_id: b.threadId });
    await setSetting(orgId, MK, 'board', { ...b, date, messageId: m.message_id });
}
const touchBoard = (ctx: Ctx, orgId: number) => refreshBoard(ctx.telegram, orgId).catch((err) => console.error('[현황판 갱신 실패]:', getErrorMessage(err)));

// 현황판을 둘 주제(토픽)에서 '/특전대 현황판' — 해제는 '/특전대 현황판 해제'
async function setBoard(ctx: Ctx, a: A, args: string) {
    if (/해제|끄기/.test(args)) {
        await setSetting(a.org.id, MK, 'board', null);
        return void (await ctx.reply('📌 현황판을 껐습니다.'));
    }
    const threadId = ctx.msg?.is_topic_message ? ctx.msg.message_thread_id : undefined;
    await setSetting(a.org.id, MK, 'board', { chatId: ctx.chat.id, threadId });
    await audit(a.org.id, a.userId, 'board.set', ctx.chat.id, { threadId });
    await refreshBoard(ctx.telegram, a.org.id);
}

const STAT_FIELDS: Record<R.FormKind, R.FieldKey[]> = {
    dig: ['region', 'team', 'guide', 'tool', 'age_group', 'gender'],
    find: ['region', 'team', 'guide', 'target_month'],
};
function resultStats(rows: S.ResultRow[]): string {
    if (!rows.length) return '• 접수된 결과가 없습니다.';
    const lines: string[] = [];
    for (const kind of ['dig', 'find'] as R.FormKind[]) {
        const mine = rows.filter((r) => r.kind === kind);
        lines.push(`<b>${R.FORMS[kind].label}</b> ${mine.length}건`);
        if (!mine.length) continue;
        for (const k of STAT_FIELDS[kind]) {
            lines.push(
                `• ${R.fieldLabel(k)}: ${R.countBy(mine, k)
                    .map(([v, n]) => `${e(v)} ${n}`)
                    .join(' · ')}`
            );
        }
    }
    const incomplete = rows.filter((r) => R.missingCount(r) > 0);
    lines.push(`• 미확인(미입력 항목 있는) 결과: ${incomplete.length}건 (빈 항목 ${incomplete.reduce((s, r) => s + R.missingCount(r), 0)}개)`);
    return lines.join('\n');
}

async function personal(ctx: Ctx, a: A, args: string) {
    const period = (await S.getPeriodByWeek(a.org.id, weekStartOf(today()))) ?? (await S.getLatestPeriod(a.org.id));
    const { members, subs, min } = await loadWeek(a.org.id, period);
    const ws = weekStartOf(today());
    const results = await S.listResults(a.org.id, { from: ws, to: dayjs(ws).add(6, 'day').format('YYYY-MM-DD') });
    if (args) {
        const m = members.find((x) => x.telegram_id === args || x.display_name === args);
        if (!m) return void (await ctx.reply('⚠️ 해당 대원을 찾을 수 없습니다. 이름 또는 텔레그램 ID로 입력해주세요.'));
        return personDetail(ctx, a, m.id);
    }
    const w = weekdayOf(today());
    let html = `👥 <b>[개인별 활동 및 결과]</b>${period ? ` 활동 시간: ${weekLabel(period.week_start)} 주차` : ''}\n결과 집계: 이번 주 (${weekLabel(ws)}) · 결과 건수는 실제 활동 시간이 아닙니다\n\n`;
    html += members
        .map((m) => {
            const days = subs.get(m.user_id)?.days;
            const mine = results.filter((r) => r.user_id === m.user_id);
            const todayStatus = T.dayStatus(days?.[w], min);
            const todayTxt = todayStatus === 'ok' || todayStatus === 'short' ? `${T.fmtHours(T.totalMinutes(days![w].slots))} ${T.STATUS_LABEL[todayStatus]}` : T.STATUS_LABEL[todayStatus];
            const short = days ? T.WEEKDAYS.filter((x) => T.dayStatus(days[x], min) === 'short').map((x) => T.DAY_NAMES[x]) : [];
            return (
                `• <b>${e(m.display_name)}</b>\n   오늘 ${todayTxt} · 결과 ${mine.filter((r) => r.activity_date === today()).length}건\n` +
                `   주간 ${days ? T.fmtHours(weeklyMinutes(days)) : '⏳ 미제출'} · 결과 ${mine.length}건${short.length ? ` · 미달: ${short.join(',')}` : ''}`
            );
        })
        .join('\n');
    await show(
        ctx,
        members.length ? html : '등록된 대원이 없습니다.',
        chunk(
            members.map((m) => btn(m.display_name.slice(0, 20), `sd:pm:${m.id}`)),
            3
        )
    );
}

async function personDetail(ctx: Ctx, a: A, membershipId: number) {
    const m = await getMember(a.org.id, MK, { id: membershipId });
    if (!m) return show(ctx, '⚠️ 대원을 찾을 수 없습니다.');
    const period = (await S.getPeriodByWeek(a.org.id, weekStartOf(today()))) ?? (await S.getLatestPeriod(a.org.id));
    const { subs, min } = await loadWeek(a.org.id, period);
    const ws = weekStartOf(today());
    const results = await S.listResults(a.org.id, { userId: m.user_id, from: ws, to: dayjs(ws).add(6, 'day').format('YYYY-MM-DD') });
    const recent = (await S.listResults(a.org.id, { userId: m.user_id })).slice(0, 5);
    const pii = piiHere(ctx, a);
    await replyLong(
        ctx,
        `👤 <b>${e(m.display_name)}</b> (ID <code>${m.telegram_id}</code> · ${m.status})\n` +
            (period ? `\n<b>[활동 가능 시간] ${weekLabel(period.week_start)}</b>\n${renderPersonWeek(period.week_start, subs.get(m.user_id)?.days, min)}\n` : '\n취합 주차 없음\n') +
            `\n<b>[결과]</b> 오늘 ${results.filter((r) => r.activity_date === today()).length}건 · 이번 주 ${results.length}건\n` +
            (recent.length ? `<b>최근 결과</b>\n${recent.map((r) => resultLine(r, pii)).join('\n')}` : '최근 결과 없음')
    );
}

async function unsubmitted(ctx: Ctx, a: A, args: string) {
    const { period } = await pickPeriod(a, args);
    if (!period) return void (await ctx.reply('⚠️ 취합 주차가 없습니다.'));
    const { members, subs } = await loadWeek(a.org.id, period);
    const missing = members.filter((m) => !subs.has(m.user_id));
    await replyLong(
        ctx,
        `⏳ <b>[미제출자] ${weekLabel(period.week_start)}</b> (${period.status === 'open' ? '제출 받는 중' : '마감'})\n` +
            `제출 ${members.length - missing.length}/${members.length}명\n\n` +
            (missing.length ? missing.map((m) => `• ${e(m.display_name)}`).join('\n') : '🎉 모두 제출했습니다.')
    );
}

async function shortage(ctx: Ctx, a: A, args: string) {
    const { period } = await pickPeriod(a, args);
    if (!period) return void (await ctx.reply('⚠️ 취합 주차가 없습니다.'));
    const { members, subs, min } = await loadWeek(a.org.id, period);
    const short: string[] = [];
    const unavailable: string[] = [];
    for (const m of members) {
        const days = subs.get(m.user_id)?.days;
        if (!days) continue;
        const s = T.WEEKDAYS.filter((w) => T.dayStatus(days[w], min) === 'short');
        const u = T.WEEKDAYS.filter((w) => days[w].unavailable);
        if (s.length) short.push(`• ${e(m.display_name)}: ${s.map((w) => `${T.DAY_NAMES[w]} ${T.fmtHours(T.totalMinutes(days[w].slots))}(-${T.fmtHours(min - T.totalMinutes(days[w].slots))})`).join(', ')}`);
        if (u.length) unavailable.push(`• ${e(m.display_name)}: ${u.map((w) => T.DAY_NAMES[w]).join(', ')}`);
    }
    await replyLong(
        ctx,
        `⚠️ <b>[부족 시간] ${weekLabel(period.week_start)}</b> — 하루 기준 ${T.fmtHours(min)}\n\n` +
            `<b>미충족</b>\n${short.join('\n') || '없음'}\n\n<b>활동 불가로 제출</b>\n${unavailable.join('\n') || '없음'}\n\n(미제출자는 /특전대 미제출)`
    );
}

/* ====================== 결과 검색 · CSV ====================== */

const SEARCH_KEYS: Record<string, R.FieldKey | 'date' | 'kind'> = {
    기간: 'date',
    날짜: 'date',
    종류: 'kind',
    이름: 'name',
    연락처: 'phone',
    생년: 'age_group',
    생년월일: 'birth_date',
    성별: 'gender',
    인도지역: 'region',
    지역: 'region',
    인도팀: 'team',
    팀: 'team',
    인도자: 'guide',
    도구: 'tool',
    장소: 'meet_place',
    목표월: 'target_month',
};

export function parseSearch(args: string): { filter: S.ResultFilter; error?: string } {
    const filter: S.ResultFilter = { fields: {} };
    const text = args.normalize('NFKC');
    if (!text.trim()) return { filter };
    const keys = Object.keys(SEARCH_KEYS).sort((x, y) => y.length - x.length);
    const marks = [...text.matchAll(new RegExp(`(?:^|\\s)(${keys.join('|')})\\s*:\\s*`, 'g'))];
    if (!marks.length) return { filter, error: '검색 조건을 찾지 못했습니다.' };
    for (const [i, m] of marks.entries()) {
        const value = text.slice(m.index! + m[0].length, marks[i + 1]?.index ?? text.length).trim();
        const key = SEARCH_KEYS[m[1]];
        if (key === 'kind') {
            if (!/^(발굴|찾기)/.test(value)) return { filter, error: `종류는 발굴 또는 찾기: ${value}` };
            filter.kind = value.startsWith('발굴') ? 'dig' : 'find';
            continue;
        }
        if (key !== 'date') {
            filter.fields![key] = value;
            continue;
        }
        const [from, to] = value.split('~').map((x) => parseFlexibleDate(x.trim()));
        if (!from || (value.includes('~') && !to)) return { filter, error: `날짜를 알 수 없습니다: ${value}` };
        filter.from = from;
        filter.to = to || from;
    }
    return { filter };
}

async function search(ctx: Ctx, a: A, args: string) {
    const { filter, error } = parseSearch(args);
    const usage =
        '사용법: <code>/특전대 결과검색 기간:10.1~10.24 인도지역:서울 도구:전단</code>\n' +
        '조건: 기간/날짜, 종류(발굴/찾기), 이름, 연락처, 생년, 생년월일, 성별, 인도지역, 인도팀, 인도자, 도구, 장소, 목표월 (부분 일치)';
    if (error) return void (await ctx.reply(`⚠️ ${e(error)}\n${usage}`, { parse_mode: 'HTML' }));
    if ((filter.fields?.name || filter.fields?.phone || filter.fields?.birth_date) && !hasPerm(a, 'pii')) return void (await ctx.reply('⛔ 이름·연락처·생년월일 검색은 개인정보 조회 권한이 필요합니다.'));
    if (!args) filter.from = filter.to = today();
    const s = await session(ctx);
    s.search = { orgId: a.org.id, filter, label: args || `오늘(${today()})` };
    if (!args) await ctx.reply(usage + '\n\n조건이 없어 오늘 결과를 보여드립니다.', { parse_mode: 'HTML' });
    await searchPage(ctx, a, 0);
}

async function searchPage(ctx: Ctx, a: A, page: number) {
    const q = (await session(ctx)).search;
    if (!q || q.orgId !== a.org.id) return show(ctx, '⌛ 검색을 다시 실행해주세요: /특전대 결과검색');
    const rows = await S.listResults(a.org.id, q.filter);
    const per = 10;
    const pages = Math.max(1, Math.ceil(rows.length / per));
    const p = Math.min(Math.max(0, page), pages - 1);
    const pii = piiHere(ctx, a);
    const html =
        `🔎 <b>결과 검색</b>: ${e(q.label)}\n총 <b>${rows.length}</b>건\n${resultStats(rows)}\n\n` +
        (rows.length ? `<b>목록</b> (${p + 1}/${pages}쪽)\n${rows.slice(p * per, p * per + per).map((r) => resultLine(r, pii)).join('\n')}` : '');
    const nav = [...(p > 0 ? [btn('◀ 이전', `sd:sp:${p - 1}`)] : []), ...(p < pages - 1 ? [btn('다음 ▶', `sd:sp:${p + 1}`)] : [])];
    await show(ctx, html, [...(nav.length ? [nav] : []), ...(rows.length ? [[btn(`📥 CSV${hasPerm(a, 'pii') ? ' (개인정보 포함 · 1:1로 전송)' : ''}`, 'sd:sc')]] : [])]);
}

function resultsCsvBuffer(rows: S.ResultRow[], pii: boolean) {
    const fields = R.FIELD_KEYS.filter((k) => pii || !R.PII_FIELDS.includes(k));
    return R.toCsv(
        ['결과ID', '종류', '활동날짜', '제출 대원', ...fields.map(R.fieldLabel), '제출 시각', '수정 시각'],
        rows.map((r) => [r.id, R.FORMS[r.kind].label, r.activity_date, r.submitter, ...fields.map((k) => r[k]), r.created_at, r.updated_at])
    );
}

async function resultsCsv(ctx: Ctx, a: A, rows: S.ResultRow[], name: string) {
    const pii = hasPerm(a, 'pii');
    const buf = resultsCsvBuffer(rows, pii);
    const filename = `${name}_${nowKst().format('YYYYMMDD-HHmm')}.csv`;
    if (!pii) return sendCsv(ctx, filename, buf, `📥 ${rows.length}건 · 이름/연락처 제외`);
    await audit(a.org.id, a.userId, 'pii.export', name, { count: rows.length });
    await sendPrivately(ctx, '', { buf, filename, caption: `📥 ${rows.length}건 · 개인정보 포함 — 외부 공유 금지` });
}

/* ====================== 주차 · 대원 · 설정 관리 ====================== */

async function registerGroup(ctx: Ctx, a: A) {
    await setGroupOrg(ctx.chat.id, MK, a.org.id, ctx.chat.title, a.userId);
    await audit(a.org.id, a.userId, 'group.register', ctx.chat.id);
    await ctx.reply(
        `✅ 이 방을 [${a.org.name}] ${NAME} 단체방으로 등록했습니다.\n이제 이 방에서 /특전대 를 쓰는 사람은 가입 요청 없이 대원으로 자동 등록됩니다.\n(관리자가 비활성화한 사람은 제외 · 해제: /특전대 방해제)`
    );
}

async function unregisterGroup(ctx: Ctx, a: A) {
    await setGroupOrg(ctx.chat.id, MK, null);
    await audit(a.org.id, a.userId, 'group.unregister', ctx.chat.id);
    await ctx.reply('🔓 단체방 등록을 해제했습니다. 이제 이 방의 새 사용자는 가입 요청이 필요합니다. (이미 등록된 대원은 그대로)');
}

async function closePeriod(ctx: Ctx, a: A) {
    const p = await S.getEditablePeriod(a.org.id, -1); // -1: 수정 허용 예외 없이 '열린' 주차만
    if (!p) return void (await ctx.reply('ℹ️ 제출을 받는 주차가 없습니다.'));
    await S.setPeriodStatus(a.org.id, p.id, 'closed');
    await audit(a.org.id, a.userId, 'period.close', p.id);
    await ctx.reply(`🔒 ${weekLabel(p.week_start)} 주차 제출을 마감했습니다. (재개방: /특전대 재개방)`);
}

async function reopenPeriod(ctx: Ctx, a: A, args: string) {
    const { period } = await pickPeriod(a, args);
    if (!period) return void (await ctx.reply('⚠️ 주차가 없습니다.'));
    await S.setPeriodStatus(a.org.id, period.id, 'open');
    await audit(a.org.id, a.userId, 'period.reopen', period.id);
    await ctx.reply(`🔓 ${weekLabel(period.week_start)} 주차 제출을 다시 열었습니다.`);
}

async function startPeriod(ctx: Ctx, a: A, args: string) {
    // 날짜가 없으면 다음 주 월요일
    const date = parseFlexibleDate(args) || dayjs(weekStartOf(today())).add(7, 'day').format('YYYY-MM-DD');
    const ws = weekStartOf(date);
    const p = await S.createPeriod(a.org.id, ws);
    if (!p) return void (await ctx.reply(`ℹ️ ${weekLabel(ws)} 주차는 이미 있습니다. (마감 상태면 /특전대 재개방 ${dayjs(ws).format('M.D')})`));
    await audit(a.org.id, a.userId, 'period.start', p.id);
    await ctx.reply(`🆕 ${weekLabel(ws)} 주차 활동 시간 취합을 시작했습니다. 이전 주차 데이터는 그대로 보존됩니다.\n대원들은 /특전대 → 활동 시간 제출`);
}

async function allowEdit(ctx: Ctx, a: A, args: string) {
    const m = args ? await getMember(a.org.id, MK, { telegramId: args }) : undefined;
    const p = await S.getLatestPeriod(a.org.id);
    if (!m || !p) return void (await ctx.reply('사용법: /특전대 수정허용 <텔레그램ID>  (최신 주차가 마감된 뒤에도 그 대원만 수정 가능)'));
    await S.addExtraEditor(a.org.id, p.id, m.user_id);
    await audit(a.org.id, a.userId, 'period.allow_edit', p.id, { user_id: m.user_id });
    await ctx.reply(`✏️ ${m.display_name} 님은 ${weekLabel(p.week_start)} 주차가 마감되어도 수정할 수 있습니다.`);
}

const roleOf = (m: Membership) => (m.status !== 'active' ? (m.status === 'pending' ? '⏳ 대기' : '🚫 제외') : m.perms.includes('manager') ? '🛠 관리자' : '🪖 대원');
// 팀 관리자는 대원/제외만, 관리자 지정·관리자 변경은 시스템 관리자만
const canSetRole = (a: A, m: Membership) => a.sysadmin || !m.perms.includes('manager');

async function memberList(ctx: Ctx, a: A) {
    const all = await listMembers(a.org.id, MK, ['active', 'pending', 'inactive']);
    // 텔레그램은 단체방 전체 인원을 알려주지 않음 → 봇이 본 사람(단체방에서 말한 사람) + 단체방 텔레그램 관리자 표시
    const tgAdmins = new Set<string>();
    for (const chatId of await listGroupChats(a.org.id, MK)) {
        const admins = await ctx.telegram.getChatAdministrators(chatId).catch(() => []);
        for (const x of Array.isArray(admins) ? admins : []) tgAdmins.add(String(x.user.id));
    }
    const count = (r: string) => all.filter((m) => roleOf(m) === r).length;
    await show(
        ctx,
        `🧑‍🤝‍🧑 <b>[${NAME} 인원]</b> ${e(a.org.name)}\n🪖 대원 ${count('🪖 대원')}명 · 🛠 관리자 ${count('🛠 관리자')}명 · 🚫 제외 ${count('🚫 제외')}명${count('⏳ 대기') ? ` · ⏳ 대기 ${count('⏳ 대기')}명` : ''}\n\n` +
            all.map((m) => `${roleOf(m)} ${e(m.display_name)}${tgAdmins.has(m.telegram_id) ? ' 👑' : ''} · <code>${m.telegram_id}</code>`).join('\n') +
            '\n\n👇 이름을 눌러 대원 / 관리자 / 제외를 바꿉니다. 대원만 활동 시간·미제출 집계에 들어갑니다.' +
            '\n• 단체방에서 한 번이라도 말한 사람만 목록에 나옵니다 (텔레그램 정책상 전체 인원은 볼 수 없음). 👑 = 단체방 관리자' +
            '\n• 직접 추가: <code>/특전대 등록 ID 이름</code> · 이름 변경: <code>/특전대 이름 ID 새이름</code>',
        chunk(
            all.map((m) => btn(`${roleOf(m).split(' ')[0]} ${m.display_name}${tgAdmins.has(m.telegram_id) ? ' 👑' : ''}`, `sd:mr:${m.id}`)),
            2
        )
    );
}

async function memberRole(ctx: Ctx, a: A, arg: string) {
    const [id, role] = arg.split('-');
    const m = await getMember(a.org.id, MK, { id: Number(id) });
    if (!m) return;
    if (!canSetRole(a, m)) return void (await ctx.reply('⛔ 관리자 변경은 시스템 관리자만 할 수 있습니다.'));
    if (role) {
        if (role === 'manager' && !a.sysadmin) return void (await ctx.reply('⛔ 관리자 지정은 시스템 관리자만 할 수 있습니다.'));
        const patch =
            role === 'out' ? { status: 'inactive' } : { status: 'active', perms: role === 'manager' ? (['manager', ...(m.perms.includes('pii') ? ['pii'] : [])] as Perm[]) : (['member'] as Perm[]) };
        await updateMembership(a.org.id, m.id, patch);
        await audit(a.org.id, a.userId, 'member.role', m.id, { role });
        return memberList(ctx, a);
    }
    const choices = [btn('🪖 대원', `sd:mr:${m.id}-member`), ...(a.sysadmin ? [btn('🛠 관리자', `sd:mr:${m.id}-manager`)] : []), btn('🚫 제외', `sd:mr:${m.id}-out`)];
    await show(ctx, `👤 <b>${e(m.display_name)}</b> (<code>${m.telegram_id}</code>)\n지금: ${roleOf(m)}\n\n• 대원: 활동 시간·결과 제출, 집계 대상\n• 관리자: 1:1 대화에서 현황·보고서, 집계 제외\n• 제외: 봇 사용 불가, 집계 제외`, [
        choices,
        [btn('◀ 목록', 'sd:a:대원')],
    ]);
}

async function pendingList(ctx: Ctx, a: A) {
    const pending = await listMembers(a.org.id, MK, ['pending']);
    if (!pending.length) return void (await ctx.reply('🙋 대기 중인 가입 요청이 없습니다.'));
    await ctx.reply(`🙋 <b>가입 요청 ${pending.length}건</b>\n${pending.map((m) => `• ${e(m.display_name)} (<code>${m.telegram_id}</code>)`).join('\n')}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(pending.map((m) => [btn(`✅ ${m.display_name}`, `sd:ap:${a.org.id}-${m.id}`), btn('❌ 거절', `sd:rj:${a.org.id}-${m.id}`)])),
    });
}

async function registerMember(ctx: Ctx, a: A, args: string) {
    const m = args.match(/^(\d{1,15})\s+(.{1,30})$/);
    if (!m) return void (await ctx.reply('사용법: /특전대 등록 <텔레그램ID> <이름>\n(텔레그램 ID는 대상자가 봇에게 /내아이디 로 확인)'));
    const user = await upsertUser(m[1], '');
    const mem = await upsertMembership(a.org.id, user.id, MK, m[2].trim(), 'active');
    await audit(a.org.id, a.userId, 'member.register', mem.id, { telegram_id: m[1] });
    await ctx.reply(`✅ ${mem.display_name} (${m[1]}) 대원 등록 완료`);
}

async function setStatus(ctx: Ctx, a: A, args: string, status: 'active' | 'inactive') {
    const m = args ? await getMember(a.org.id, MK, { telegramId: args }) : undefined;
    if (!m) return void (await ctx.reply(`사용법: /특전대 ${status === 'active' ? '활성' : '비활성'} <텔레그램ID>`));
    await updateMembership(a.org.id, m.id, { status });
    await audit(a.org.id, a.userId, `member.${status}`, m.id);
    await ctx.reply(`${status === 'active' ? '✅ 활성화' : '🚫 비활성화'}: ${m.display_name}`);
}

async function rename(ctx: Ctx, a: A, args: string) {
    const [id, ...rest] = args.split(/\s+/);
    const m = id ? await getMember(a.org.id, MK, { telegramId: id }) : undefined;
    const name = rest.join(' ').trim().slice(0, 30);
    if (!m || !name) return void (await ctx.reply('사용법: /특전대 이름 <텔레그램ID> <새 이름>'));
    await updateMembership(a.org.id, m.id, { display_name: name });
    await audit(a.org.id, a.userId, 'member.rename', m.id);
    await ctx.reply(`✏️ ${m.display_name} → ${name}`);
}

async function setPerms(ctx: Ctx, a: A, args: string) {
    const [id, list = ''] = args.split(/\s+/);
    const perms = [...new Set(list.split(',').map((x) => x.trim()))].filter((x): x is Perm => (PERMS as string[]).includes(x));
    const m = id ? await getMember(a.org.id, MK, { telegramId: id }) : undefined;
    if (!m || !perms.length) return void (await ctx.reply('사용법: /특전대 권한 <텔레그램ID> member,manager,pii\nmember=대원, manager=팀 관리자, pii=개인정보 조회'));
    await updateMembership(a.org.id, m.id, { perms });
    await audit(a.org.id, a.userId, 'member.perms', m.id, { perms });
    await ctx.reply(`🔑 ${m.display_name}: ${perms.map((p) => PERM_LABEL[p]).join(', ')}`);
}

const OPTION_LABELS: Record<string, R.FieldKey> = { 인도지역: 'region', 인도팀: 'team', 인도자: 'guide', 도구: 'tool', 성별: 'gender' };

async function options(ctx: Ctx, a: A, args: string) {
    const m = args.match(/^(추가|삭제)\s+(\S+)\s+(.{1,50})$/);
    if (m) {
        const field = OPTION_LABELS[m[2]];
        if (!field) return void (await ctx.reply(`⚠️ 항목은 ${Object.keys(OPTION_LABELS).join(', ')} 중 하나입니다.`));
        if (m[1] === '추가') await S.addOption(a.org.id, field, m[3].trim());
        else if (!(await S.removeOption(a.org.id, field, m[3].trim()))) return void (await ctx.reply('⚠️ 해당 값이 목록에 없습니다.'));
        await audit(a.org.id, a.userId, `option.${m[1] === '추가' ? 'add' : 'remove'}`, field, { value: m[3].trim() });
    }
    const opts = await S.listOptions(a.org.id);
    await ctx.reply(
        `📋 <b>선택 목록</b> (${e(a.org.name)})\n${Object.entries(OPTION_LABELS)
            .map(([label, k]) => `• ${label}: ${(opts[k] || []).map(e).join(', ') || '(없음 — 직접 입력)'}`)
            .join('\n')}\n\n<code>/특전대 옵션 추가 인도지역 서울</code> · <code>/특전대 옵션 삭제 도구 전단</code>`,
        { parse_mode: 'HTML' }
    );
}

async function setMin(ctx: Ctx, a: A, args: string) {
    const h = Number(args);
    if (!(h > 0 && h <= 24)) return void (await ctx.reply('사용법: /특전대 기준 6   (하루 최소 활동 가능 시간, 0.5 단위 가능)'));
    await setSetting(a.org.id, MK, 'min_minutes', Math.round(h * 60));
    await audit(a.org.id, a.userId, 'setting.min_minutes', null, { hours: h });
    await ctx.reply(`⏱ 하루 기준이 ${T.fmtHours(Math.round(h * 60))}으로 설정되었습니다.`);
}

async function setRetention(ctx: Ctx, a: A, args: string) {
    const days = args === '해제' ? null : Number(args);
    if (days !== null && !(days >= 30)) return void (await ctx.reply('사용법: /특전대 보관기간 365  (30일 이상, 지난 결과의 이름·연락처를 매일 밤 삭제) · /특전대 보관기간 해제'));
    await setSetting(a.org.id, MK, 'pii_retention_days', days);
    await audit(a.org.id, a.userId, 'setting.pii_retention_days', null, { days });
    await ctx.reply(days ? `🗂 활동일로부터 ${days}일이 지난 결과의 이름·연락처를 자동 삭제합니다 (/cron-10pm 실행 시).` : '🗂 개인정보 자동 삭제를 해제했습니다.');
}

const HELP_MEMBER =
    `🪖 <b>[${NAME} 사용법]</b> (대원: 단체방 · 관리자: 봇과 1:1 대화)\n\n` +
    '• <code>/특전대</code> — 메뉴\n' +
    '• 활동 가능 시간 (월~일): <code>/활동시간</code> 밑에 한 줄에 한 요일\n<code>/활동시간\n월/12-14,18-20\n화/15-18\n수/불가</code>\n  (처음이면 안 적은 요일은 활동 불가, 이미 냈으면 적은 요일만 바뀜)\n' +
    '• <code>/특전대 내현황</code> — 내 요일별·주간 활동 가능 시간과 결과 건수\n' +
    '• <code>/특전대 결과</code> — 당일 결과 단계별 입력 (발굴건/찾기건 선택)\n' +
    '• <code>/특전대 내결과</code> — 최근 결과 확인·수정·삭제\n' +
    `• 결과 한 번에 보내기 (단체방에, 여러 건은 한 줄에 한 건 — 이미 등록된 사람은 자동 제외):\n${FORM_GUIDE}\n예: <code>발/홍길동/010-1234-5678/20대중/남/서울/1팀/김철수/전단지/+10.28 19시,강남역</code>\n` +
    '• 하루 기준 시간 이상이면 충족, 겹치는 시간은 한 번만 계산. 자정을 넘는 구간은 24:00까지만 입력';
const HELP_MANAGER =
    '\n\n👑 <b>팀 관리자</b> (봇과 1:1 대화)\n' +
    '• <code>/특전대 시간표 [날짜] [요일]</code> · <code>오늘현황 [날짜]</code> · <code>개인현황 [이름]</code>\n' +
    '• <code>/특전대 결과검색 기간:10.1~10.24 인도지역:서울</code>\n' +
    '• <code>/특전대 미제출</code> · <code>부족시간</code> · <code>마감</code> · <code>재개방 [날짜]</code> · <code>주차시작 [날짜]</code> · <code>수정허용 ID</code>\n' +
    '• 단체방에서: <code>/특전대 방등록</code> (그 방 사람은 가입 요청 없이 자동 대원) · <code>방해제</code>\n' +
    '• 현황판 둘 주제(토픽)에서: <code>/특전대 현황판</code> — 결과·활동 시간이 올라올 때마다 그 메시지를 자동 갱신 (끄기: <code>현황판 해제</code>)\n' +
    '• <code>/특전대 대원</code> — 이름 눌러 대원/관리자/제외 (대원만 집계) · <code>승인</code> · <code>등록 ID 이름</code> · <code>활성/비활성 ID</code> · <code>이름 ID 새이름</code> · <code>옵션</code> · <code>결과수정 번호</code>';
const HELP_ADMIN = '\n\n🛠 <b>시스템 관리자</b>\n• <code>/특전대 권한 ID member,manager,pii</code> · <code>기준 6</code> · <code>보관기간 365</code> · <code>/조직</code>';

async function help(ctx: Ctx, a: A) {
    await ctx.reply(HELP_MEMBER + (hasPerm(a, 'manager') ? HELP_MANAGER : '') + (a.sysadmin ? HELP_ADMIN : ''), { parse_mode: 'HTML' });
}

/* ====================== 등록 ====================== */

export function registerSida(bot: Telegraf<any>) {
    registerModule({ key: MK, name: NAME, openMenu: (ctx) => dispatch(ctx), help: HELP_MEMBER });

    const run = (fn: (ctx: Ctx, next: () => Promise<void>) => Promise<unknown>) => async (ctx: Ctx, next: () => Promise<void>) => {
        try {
            await fn(ctx, next);
            if (ctx.state.sess?.flow) ctx.state.sess.flow.at = Date.now();
        } catch (err) {
            console.error(`[${NAME} 처리 에러]:`, err);
            await ctx.reply(`⚠️ 처리 중 오류가 발생했습니다: ${getErrorMessage(err)}`).catch(() => {});
        }
    };

    bot.hears(/^[\/!](?:특전대|sd)(?:@\w+)?(?:\s+(\S+))?(?:\s+([\s\S]+))?$/i, run((ctx) => dispatch(ctx, ctx.match[1] || '', ctx.match[2] || '')));
    bot.hears(/^\/start(?:@\w+)?\s+sd$/, run((ctx) => dispatch(ctx)));
    // '/활동시간' 만 → 양식 안내, '/활동시간' + 요일별 줄 → 저장
    bot.hears(/^[\/!]?활동\s*시간(?:@\w+)?$/, run((ctx) => dispatch(ctx, '제출')));
    bot.hears(/^[\/!]활동\s*시간(?:@\w+)?\s+([\s\S]+)$/, run((ctx) => handleWeekText(ctx, ctx.match[1])));

    bot.action(
        /^sd:(\w+)(?::(.*))?$/,
        run(async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const [op, arg = ''] = [ctx.match[1], ctx.match[2] ?? ''];
            if (op === 'a') return dispatch(ctx, arg);
            if (op === 'jo') return doJoin(ctx, Number(arg));
            const a = await access(ctx);
            if (op === 'ap' || op === 'rj') return decideJoin(ctx, a, arg, op === 'ap');
            if (!a.org) return dispatch(ctx);
            const s = await session(ctx);
            const scoped = a as A;
            if (op === 'rs') return resultCb(ctx, scoped, s, arg);
            // 관리자 보고서 버튼 — 버튼을 가지고 있어도 매번 서버에서 권한 확인
            if (!hasPerm(a, 'manager') || (op === 'td' && !hasPerm(a, 'pii'))) return void (await ctx.reply('⛔ 권한이 없습니다.'));
            if (!inPrivate(ctx)) return void (await ctx.reply(MSG_GO_DM, dmButton(ctx)));
            if (op === 'tt' || op === 'tc') {
                const [pid, w] = arg.split('-').map(Number);
                const period = await S.getPeriodById(scoped.org.id, pid);
                if (!period) return;
                return op === 'tt' ? sendTimetable(ctx, scoped, period, w || 0) : timetableCsv(ctx, scoped, period);
            }
            if (op === 'td') {
                const rows = await S.listResults(scoped.org.id, { from: arg, to: arg });
                await audit(scoped.org.id, a.userId, 'pii.view', arg, { count: rows.length });
                // 상세 목록과 CSV 모두 1:1 대화로
                const html = `📇 <b>[상세 결과] ${arg}</b> ${rows.length}건 — 개인정보 포함, 외부 공유 금지\n\n${rows.map((r) => resultLine(r, true)).join('\n')}`;
                const buf = resultsCsvBuffer(rows, true);
                return sendPrivately(ctx, html, { buf, filename: `results_${arg}.csv`, caption: `📥 ${arg} 결과 ${rows.length}건 · 외부 공유 금지` });
            }
            if (op === 'sp') return searchPage(ctx, scoped, Number(arg));
            if (op === 'sc') {
                const q = s.search;
                if (!q || q.orgId !== scoped.org.id) return void (await ctx.reply('⌛ 검색을 다시 실행해주세요.'));
                return resultsCsv(ctx, scoped, await S.listResults(scoped.org.id, q.filter), 'results_search');
            }
            if (op === 'pm') return personDetail(ctx, scoped, Number(arg));
            if (op === 'mr') return memberRole(ctx, scoped, arg);
        })
    );

    // 일반 텍스트: 결과 양식 → 진행 중인 입력 → (아니면) 다음 핸들러로
    bot.on(
        'text',
        run(async (ctx, next) => {
            const text: string = ctx.message.text;
            if (/^[\/!]/.test(text)) return next();
            const s = await session(ctx);
            const fresh = inPrivate(ctx) || Date.now() - (s.flow?.at || 0) < FLOW_TTL_MS;
            const f = s.flow?.chatId === ctx.chat.id && fresh ? s.flow : undefined;
            // 입력 중이라도 결과 양식 전체를 붙여넣으면 자동 정리로 시작 (시간 구간 '09:00~12:00' 은 양식 줄로 인식되지 않음)
            if (await handleFreeForm(ctx, text)) return;
            if (f?.kind === 'result') return setField(ctx, f, text);
            return next();
        })
    );
}
