// 인터뷰 추적 모듈 (/인터뷰): 등록된 방에 올린 당일 인터뷰 결과지를 사람별로 저장하고,
// 카운셀링 봇 행정 DB(students)에 등록됐는지·몇 단계인지 추적. 특전대와 권한·방·데이터 모두 별개
import { Markup, Telegraf } from 'telegraf';
import { Access, askOrg, hasPerm, Need, registerModule, resolveAccess, session } from '../core/engine';
import { audit, autoEnroll, getGroupOrg, getMember, listMembers, listOrgs, Perm, PERMS, setGroupOrg, setSetting, updateMembership, upsertMembership, upsertUser } from '../core/store';
import { refreshBoard } from '../sida/bot';
import * as R from '../sida/result';
import * as SS from '../sida/store';
import { dayjs, escapeHtml as e, nowKst, parseFlexibleDate, replyLong } from '../utils';
import { FOLLOW_UPS, InterviewKind, parseInterviewSheet, sheetKind } from './parse';
import * as S from './store';
import { interviewToForms } from './toSida';

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
    단계: { label: '📈 찾등·합등 (전체)', need: 'pii', place: 'private', run: (ctx, a, args) => stageUps(ctx, a, args) },
    행정: { label: '📋 행정 등록자 상태', need: 'pii', place: 'private', run: (ctx, a, args) => registered(ctx, a, args) },
    미등록: { label: '⏳ 행정 미등록', need: 'pii', place: 'private', run: (ctx, a, args) => unregistered(ctx, a, args) },
    검색: { need: 'pii', place: 'private', run: (ctx, a, args) => searchName(ctx, a, args) },
    삭제: { need: null, place: 'any', run: (ctx, a, args) => removeInterview(ctx, a, args) },
    특전대: { need: 'manager', place: 'any', run: (ctx, a, args) => sidaPreview(ctx, a, args) }, // 특전대 기간에만 (메뉴엔 안 보임)
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
    // 확인 필요: 인도자 없음(행정은 지역으로만 찾음), 행정 미연결·동명이인 — 후속 X 는 행정에 없는 게 보통이라 제외
    const st = r.linkError ? [] : (await S.savedStatus(a.org!.id, date, entries.map((x) => x.name))).filter((x) => x.follow_up !== 'X');
    const names = (xs: { name: string }[]) => xs.map((x) => e(x.name)).join(', ');
    const checks = [
        ['인도자 없음', entries.filter((x) => x.followUp !== 'X' && !x.guides.length)],
        ['행정에서 못 찾음', st.filter((x) => !x.student_id && x.match_note === 'none')],
        ['행정에 같은 이름 여러 명', st.filter((x) => x.match_note === 'multi')],
    ].filter(([, xs]) => xs.length) as [string, { name: string }[]][];
    // 특전대 주차면 바로 특전대 결과로 등록 → 현황판에 반영
    const sida = (await inSidaWeek(a.org!.id, date)) ? await toSida(ctx, a as A, date, kind) : null;
    const checkText = checks.length
        ? `\n\n⚠️ <b>확인 필요</b> (후속 X 제외)\n${checks.map(([t, xs]) => `• ${t}: ${names(xs)}`).join('\n')}\n<i>인도자 이름이 행정과 같아야 연결됩니다. 고쳐서 다시 보내면 덮어씁니다.</i>`
        : '';
    await ctx.reply(
        `🗂 ${md(date)}${date === today() ? '(오늘)' : ''} [${kind}] 인터뷰 결과 ${entries.length}명 저장 (새로 ${r.created} · 수정 ${r.updated})\n후속연결 ${by}${noStatus ? ` · 구분 없음 ${noStatus}` : ''}` +
            `\n<i>구분이 틀리면 맨 위에 "구분: ${kind === '향수행사' ? '당터뷰' : '향수행사'}" 줄을 넣어 다시 보내주세요.</i>` +
            (!dateLine && !group ? '\n💡 지난 날짜 결과면 맨 위에 "날짜: 10.20" 줄을 넣어 다시 보내주세요 (같은 날짜·이름은 덮어씀).' : '') +
            checkText +
            (r.linkError ? '\n⚠️ 행정 DB를 읽지 못해 행정 연결은 나중에 다시 시도합니다.' : '') +
            (sida ? `\n\n${sidaSummary(date, kind, sida)}` : ''),
        { parse_mode: 'HTML' }
    );
    return true;
}

/* ====================== 특전대 결과로 등록 ====================== */
// 인터뷰한 사람은 모두 발굴건, 후속연결 O 는 찾기건도. 특전대 주차에 결과지를 올리면 자동 등록,
//   '/인터뷰 특전대' 는 미리보기 → 확인 후 등록 (대원 이름을 고친 뒤 다시 넣을 때)
// 실적 대원: 특전대 대원 중 인도자와 같은 이름(한 명일 때), 없으면 등록하지 않음

const KIND_CODE: Record<InterviewKind, string> = { 향수행사: 'h', 당터뷰: 'd' };
const kindOfCode = (c: string): InterviewKind | undefined => (c === 'h' ? '향수행사' : c === 'd' ? '당터뷰' : undefined);
const SIDA_MK = SS.MODULE_KEY; // 특전대 대원 모듈 ('special')

// 특전대 기간: 관리자가 만든 특전대 주차(월~일) 안의 날짜일 때만 등록 기능을 켬
const inSidaWeek = async (orgId: number, date: string) =>
    !!(await SS.getPeriodByWeek(orgId, weekStart(date)));
const weekStart = (date: string) => dayjs(date).subtract((dayjs(date).day() + 6) % 7, 'day').format('YYYY-MM-DD');

// 인도자 이름 → 같은 이름의 특전대 대원 (한 명일 때만)
async function sidaOwners(orgId: number) {
    const byName = new Map<string, number[]>();
    for (const m of await listMembers(orgId, SIDA_MK)) byName.set(m.display_name.replace(/\s+/g, ''), [...(byName.get(m.display_name.replace(/\s+/g, '')) || []), m.user_id]);
    return (g?: string | null) => (g && byName.get(g)?.length === 1 ? { id: byName.get(g)![0], name: g } : undefined);
}

// 특전대 기간에 발굴한 사람의 인터뷰 사후 보고서가 카운셀링 봇에 후속 [신청]으로 올라오면(만남 확인) 특전대 찾기건으로 자동 등록
//   → 현황판·웹 반영. 서버가 10분마다 호출. 이번 특전대 주차 안에 올라온 것만, 실적은 그 발굴건을 올린 대원, 같은 이름 찾기건이 이미 있으면(인터뷰 후속 O 등) 안 넣음
export async function syncAdminFinds(telegram: Telegraf['telegram']) {
    const to = today();
    const ws = weekStart(to);
    for (const org of await listOrgs()) {
        if (!(await SS.getPeriodByWeek(org.id, ws))) continue;
        let created = 0;
        for (const s of await S.adminFindsOfDigs(org.id, SIDA_MK, ws, to)) {
            if (await SS.findNameExists(org.id, s.name)) continue;
            const values = Object.fromEntries(Object.entries({ name: s.name, region: s.region, team: s.team, guide: s.guide }).filter(([, v]) => v)) as R.ResultValues;
            if (await SS.insertResult({ orgId: org.id, userId: s.user_id, kind: 'find', date: s.date, values, dedupKey: `ad:${org.id}:${s.student_id}:find` })) created++;
        }
        if (created) {
            await audit(org.id, null, 'admin.to_sida', ws, { created });
            await refreshBoard(telegram, org.id).catch((err) => console.error('[현황판 갱신 실패]:', err));
        }
    }
}

const NOT_SIDA_WEEK = 'ℹ️ 특전대 기간(주차)이 아닌 날짜라 특전대 결과로 등록하지 않습니다.';

async function sidaPlan(a: A, date: string, kind?: InterviewKind) {
    const people = (await S.listInterviews(a.org.id, { from: date, to: date, kind })).rows.filter((r) => r.name);
    const firstGuides = [...new Set(people.map((r) => r.guides[0]).filter(Boolean))];
    let info = new Map<string, { region: string | null; team: string | null }>();
    let adminError = false;
    try {
        info = await S.guideInfo(firstGuides);
    } catch {
        adminError = true;
    }
    const opts = await SS.listOptions(a.org.id);
    const ownerOf = await sidaOwners(a.org.id);
    const items = people.flatMap((r) =>
        interviewToForms(r, info.get(r.guides[0]), nowKst().year()).map((f) => {
            const c = R.cleanForm(f, opts);
            const empty = R.missingCount({ kind: c.kind, ...c.values });
            return { ...c, notes: [...c.notes, ...(empty ? [`빈 칸 ${empty}개`] : [])], key: `iv:${r.id}:${c.kind}`, owner: ownerOf(r.guides[0]) };
        })
    );
    const saved = await SS.savedKeys(items.map((x) => x.key));
    const fresh = items.filter((x) => !saved.has(x.key));
    // 인도자와 같은 이름의 대원이 없으면 등록하지 않음 (누른 사람 실적으로 잡히면 안 됨)
    const unmatched = [...new Set(fresh.filter((x) => !x.owner).map((x) => `${x.values.name}(${x.values.guide || '인도자 없음'})`))];
    return { items: fresh.filter((x) => x.owner), unmatched, already: items.length - fresh.length, adminError };
}

// 올린 양식 모양 한 줄 (발/이름/…/+2차만남일시,장소)
function sidaLine(f: R.ParsedForm) {
    const v = (k: R.FieldKey) => e(f.values[k] || '');
    if (f.kind === 'find') return `찾/${R.FORMS.find.fields.map(v).join('/')}`.replace(/\/+$/, '');
    const main = R.FORMS.dig.fields.slice(0, 8).map(v).join('/').replace(/\/+$/, '');
    return `발/${main}${f.values.meet_at || f.values.meet_place ? `/+${v('meet_at')},${v('meet_place')}` : ''}`;
}

function sidaArgs(args: string) {
    const { kind, rest } = kindArg(args);
    const date = rest ? parseFlexibleDate(rest) : today();
    return { kind, date };
}

async function sidaPreview(ctx: Ctx, a: A, args: string, given?: { date: string; kind?: InterviewKind }) {
    const { date, kind } = given ?? sidaArgs(args);
    if (!date) return void (await ctx.reply('사용법: /인터뷰 특전대 10.26 [향수|당터뷰]'));
    if (!(await inSidaWeek(a.org.id, date))) return void (await ctx.reply(NOT_SIDA_WEEK));
    const p = await sidaPlan(a, date, kind);
    const title = `🪖 <b>${md(date)}${kindTitle(kind)} 특전대 결과로 등록</b>`;
    const skipped = p.unmatched.length ? `\n\n⏭ 인도자와 같은 이름의 특전대 대원이 없어 제외 ${p.unmatched.length}명: ${e(p.unmatched.join(', '))}` : '';
    if (!p.items.length) return void (await ctx.reply(`${title}\n\n등록할 사람이 없습니다.${p.already ? ` (이미 등록 ${p.already}건)` : ''}${skipped}`, { parse_mode: 'HTML' }));
    const dig = p.items.filter((x) => x.kind === 'dig').length;
    const lines = p.items.map((x) => `${sidaLine(x)}\n  → 대원 ${e(x.owner!.name)}${x.notes.length ? ` · ⚠️ ${e(x.notes.join(', '))}` : ''}`);
    await replyLong(
        ctx,
        `${title}\n발굴 ${dig}건 · 찾기 ${p.items.length - dig}건${p.already ? ` · 이미 등록 ${p.already}건 제외` : ''}\n` +
            `<i>모두 발굴, 후속연결 O 는 찾기도. 인도지역·인도팀은 행정 인도자 정보로 채움</i>` +
            (p.adminError ? '\n⚠️ 행정 DB를 읽지 못해 인도팀이 비어 있습니다.' : '') +
            `\n\n${lines.join('\n')}${skipped}\n\n빈 칸은 등록 후 특전대 <code>/특전대 내결과</code> 에서 고칠 수 있습니다.`,
        { ...Markup.inlineKeyboard([[btn(`✅ ${p.items.length}건 등록`, `iv:sd:ok:${date}:${kind ? KIND_CODE[kind] : 'a'}`)]]) }
    );
}

async function sidaRegister(ctx: Ctx, a: A, date: string, kind?: InterviewKind) {
    if (!(await inSidaWeek(a.org.id, date))) return void (await ctx.reply(NOT_SIDA_WEEK));
    await ctx.reply(sidaSummary(date, kind, await toSida(ctx, a, date, kind)), { parse_mode: 'HTML' });
}

function sidaSummary(date: string, kind: InterviewKind | undefined, x: { created: number; dups: string[]; unmatched: string[] }) {
    return (
        `🪖 ${md(date)}${kindTitle(kind)} 특전대 결과 ${x.created}건 등록 (현황판 반영)` +
        (x.dups.length ? `\n⏭ 이미 특전대에 있는 사람 ${x.dups.length}건 제외: ${x.dups.join(', ')}` : '') +
        (x.unmatched.length ? `\n⏭ 인도자와 같은 이름의 특전대 대원이 없어 제외 ${x.unmatched.length}명: ${e(x.unmatched.join(', '))}` : '')
    );
}

async function toSida(ctx: Ctx, a: A, date: string, kind?: InterviewKind) {
    const p = await sidaPlan(a, date, kind);
    let created = 0;
    const dups: string[] = [];
    for (const x of p.items) {
        const who = R.personOf(x.kind, x.values);
        if ((who && (await SS.isDuplicateResult(a.org.id, x.kind, who.name, who.digits))) || (x.kind === 'find' && (await SS.findNameExists(a.org.id, x.values.name!)))) {
            dups.push(`${R.FORMS[x.kind].marker} ${e(x.values.name!)}`);
            continue;
        }
        if (await SS.insertResult({ orgId: a.org.id, userId: x.owner!.id, kind: x.kind, date, values: x.values, dedupKey: x.key })) created++;
    }
    await audit(a.org.id, a.userId, 'interview.to_sida', date, { created, kind: kind ?? null });
    if (created) await refreshBoard(ctx.telegram, a.org.id).catch((err) => console.error('[현황판 갱신 실패]:', err));
    return { created, dups, unmatched: p.unmatched };
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
    const kb = hasPerm(a, 'pii')
        ? Markup.inlineKeyboard([[...(linked.length ? [btn('📋 행정 등록자 상태', 'iv:a:행정')] : []), ...(waiting.length ? [btn('⏳ 미등록 명단', 'iv:a:미등록')] : [])]])
        : {};
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

// 행정에 등록된 인터뷰 대상자를 현재 단계별로 (높은 단계부터, 탈락은 맨 아래). 기본 전체 기간, 기간은 인터뷰 날짜 기준
async function registered(ctx: Ctx, a: A, rawArgs: string) {
    const { kind, rest: args } = kindArg(rawArgs);
    const period = args ? range(args, 30) : null;
    const { rows, adminError } = await load(a, { kind, ...(period ?? {}) });
    if (adminError) return void (await ctx.reply(ADMIN_WARN));
    const seen = new Set<string>();
    const people = rows.filter((r) => r.student_id && !seen.has(r.student_id) && seen.add(r.student_id)); // 같은 사람 여러 번 인터뷰 → 최근 1건
    await audit(a.org.id, a.userId, 'interview.pii_view', 'registered', { count: people.length, kind, period });
    const title = `📋 <b>행정 등록자 상태${kindTitle(kind)}</b> ${period ? `인터뷰 ${md(period.from)}~${md(period.to)}` : '전체 기간'}`;
    if (!people.length) return void (await replyLong(ctx, `${title}\n\n행정에 등록된 인터뷰 대상자가 없습니다.`));
    const groups = new Map<string, S.InterviewRow[]>();
    for (const r of people) groups.set(stageOf(r), [...(groups.get(stageOf(r)) || []), r]);
    const order = [...groups.keys()].sort((x, y) => (x === '탈락' ? 1 : y === '탈락' ? -1 : stageRank(y) - stageRank(x)));
    const blocks = order.map((st) => {
        const lines = groups.get(st)!.map((r) => `• <b>${e(r.name ?? '(이름 삭제됨)')}</b> [${r.kind}] <i>(인터뷰 ${md(r.interview_date)}${who(r) ? ` · ${who(r)}` : ''})</i>`);
        return `<b>[${e(st)} ${lines.length}명]</b>\n${lines.join('\n')}`;
    });
    await replyLong(
        ctx,
        `${title}\n\n• 행정 등록 <b>${people.length}명</b> — ${stageCounts(people)}\n\n${blocks.join('\n\n')}\n\n<i>행정 DB의 현재 단계 · 개인정보 포함 — 외부 공유 금지</i>`
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

// 인터뷰 대상자 중 행정에서 찾등·합등이 된 사람. 기본은 전체 기간, 기간을 적으면 그 기간에 완료된 사람만
//   완료일(찾_완료일·합_완료일)이 있거나, 비어 있어도 현재 단계가 그 이상(예: 섭)이면 된 것으로 봄 (기간을 적으면 완료일 기준만)
//   합등한 사람은 찾등 명단에 다시 넣지 않음
//   후속연결 O 는 행정 연결·완료일이 없어도 찾등 (날짜 = 인터뷰 날짜)
async function stageUps(ctx: Ctx, a: A, rawArgs: string) {
    const { kind, rest: args } = kindArg(rawArgs);
    const period = args ? range(args, 7) : null;
    const { rows, adminError } = await load(a, { kind });
    if (adminError) return void (await ctx.reply(ADMIN_WARN));
    const seen = new Set<string>();
    const fu = (r: S.InterviewRow) => r.follow_up === 'O';
    const people = rows
        .filter((r) => r.student_id || (fu(r) && r.name))
        .filter((r) => {
            const k = r.student_id ?? `n:${r.name}`;
            return !seen.has(k) && !!seen.add(k);
        }) // 같은 사람 여러 번 인터뷰 → 최근 1건
        .map((r) => (fu(r) && !r.chat_date ? { ...r, chat_date: r.interview_date } : r));
    const rankOf = (r: S.InterviewRow) => STAGE_ORDER.indexOf(String(r.stage ?? '').trim().charAt(0));
    const reached = (r: S.InterviewRow, key: 'chat_date' | 'hap_date', stage: string) =>
        period ? !!r[key] && r[key]! >= period.from && r[key]! <= period.to : !!r[key] || rankOf(r) >= STAGE_ORDER.indexOf(stage);
    const hap = people.filter((r) => reached(r, 'hap_date', '합'));
    const chat = people.filter((r) => reached(r, 'chat_date', '찾'));
    const chatOnly = chat.filter((r) => !hap.includes(r));
    await audit(a.org.id, a.userId, 'interview.pii_view', 'stage_ups', { period, kind });

    const byDate = (key: 'chat_date' | 'hap_date') => (x: S.InterviewRow, y: S.InterviewRow) => (y[key] ?? '').localeCompare(x[key] ?? ''); // 최근 완료부터, 날짜 없으면 끝
    const line = (r: S.InterviewRow, key: 'chat_date' | 'hap_date') =>
        `• ${r[key] ? md(r[key]!) : '날짜 없음'} <b>${e(r.name ?? '(이름 삭제됨)')}</b> [${r.kind}]${fu(r) ? ' [후속O]' : ''} 현재 ${e(stageOf(r))} <i>(인터뷰 ${md(r.interview_date)}${who(r) ? ` · ${who(r)}` : ''})</i>`;
    const section = (title: string, list: S.InterviewRow[], key: 'chat_date' | 'hap_date') =>
        list.length ? `\n<b>[${title} ${list.length}명]</b>\n${[...list].sort(byDate(key)).map((r) => line(r, key)).join('\n')}\n` : '';
    // 구분별·인터뷰자별 건수
    const tally = (keyOf: (r: S.InterviewRow) => string | null) => {
        const m = new Map<string, { chat: number; hap: number }>();
        for (const r of chat.concat(hap.filter((x) => !chat.includes(x)))) {
            const k = keyOf(r) || '(미입력)';
            const c = m.get(k) ?? { chat: 0, hap: 0 };
            if (chat.includes(r)) c.chat++;
            if (hap.includes(r)) c.hap++;
            m.set(k, c);
        }
        return [...m.entries()].sort((x, y) => y[1].chat - x[1].chat).map(([k, c]) => `• ${e(k)}: 찾등 ${c.chat} · 합등 ${c.hap}`).join('\n');
    };
    const total = chat.length + hap.length;
    await replyLong(
        ctx,
        `📈 <b>인터뷰 대상자 찾등·합등${kindTitle(kind)}</b> ${period ? `${md(period.from)}~${md(period.to)}` : '전체 기간'}\n\n` +
            `• 행정 연결·후속O ${people.length}명 중 찾등 <b>${chat.length}명</b> · 합등 <b>${hap.length}명</b>\n` +
            (total
                ? section('합등', hap, 'hap_date') +
                  section('찾등 (합등 전)', chatOnly, 'chat_date') +
                  (kind ? '' : `\n<b>[구분별]</b>\n${tally((r) => r.kind)}\n`) +
                  `\n<b>[인터뷰자별]</b>\n${tally((r) => r.interviewer)}\n`
                : `\n${period ? '이 기간에 ' : ''}찾등·합등한 인터뷰 대상자가 없습니다.\n`) +
            `\n<i>행정 DB 기준 (날짜 = 찾·합 완료일, 후속연결 O 는 인터뷰 날짜에 찾등) · 개인정보 포함 — 외부 공유 금지</i>`
    );
}

// '/인터뷰 삭제 9.12 왕새문' — 올린 본인 또는 관리자만
async function removeInterview(ctx: Ctx, a: A, args: string) {
    const m = args.match(/^(\S+)\s+(.+)$/);
    const date = m ? parseFlexibleDate(m[1]) : null;
    if (!m || !date) return void (await ctx.reply('사용법: /인터뷰 삭제 9.12 이름 (인터뷰 날짜와 이름)'));
    if (!hasPerm(a, 'member') && !hasPerm(a, 'manager')) return void (await ctx.reply('⛔ 이 기능을 사용할 권한이 없습니다.'));
    const row = await S.findInterview(a.org.id, date, m[2].trim());
    if (!row) return void (await ctx.reply(`🔎 ${md(date)} "${m[2].trim()}" 인터뷰 기록이 없습니다.`));
    if (row.user_id !== a.userId && !hasPerm(a, 'manager')) return void (await ctx.reply('⛔ 본인이 올린 결과만 삭제할 수 있습니다. (관리자는 모두 가능)'));
    await S.deleteInterview(a.org.id, row.id);
    await audit(a.org.id, a.userId, 'interview.delete', row.id, { date, kind: row.kind });
    await ctx.reply(`🗑 ${md(date)} [${row.kind}] ${row.name} 인터뷰 기록을 삭제했습니다.`);
}

/* ====================== 관리 ====================== */

async function registerGroup(ctx: Ctx, a: A) {
    await setGroupOrg(ctx.chat.id, MK, a.org.id, ctx.chat.title, a.userId);
    await audit(a.org.id, a.userId, 'interview.group.register', ctx.chat.id);
    await ctx.reply(`✅ 이 방을 [${a.org.name}] 인터뷰 결과 방으로 등록했습니다.\n이제 이 방에 올리는 결과지(#섭외자/성별/연락처/지역/인도자/인터뷰자/…)는 자동 저장됩니다. (해제: /인터뷰 방해제)`);
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
    `<code>▪️후속연결O\n#섭외자/성별/연락처/지역/인도자/인터뷰자/다음 만남예정일, 장소/간단정보</code>\n• 연락처는 뒷자리만 써도 됨, 모르는 칸은 <code>-</code> (예전 양식 <code>#이름/지역/인도자/인터뷰자/메모</code>도 인식)\n` +
    `• <code>▪️후속연결O / 보류 / X</code> 아래 줄이 그 상태로 저장\n• 연락처·생년월일(<code>생년월일: 990315</code>)은 메모에서 자동 인식\n` +
    `• 같은 날 같은 이름을 다시 올리면 덮어씀 · 잘못 올린 사람은 <code>/인터뷰 삭제 9.12 이름</code> (올린 본인·관리자)\n\n` +
    `<b>관리자</b> (봇과 1:1) — 명령 뒤에 <code>향수</code> 또는 <code>당터뷰</code>를 붙이면 그 구분만 (예: <code>/인터뷰 단계 향수 10.1~10.24</code>)\n• <code>/인터뷰 현황 [10.1~10.24]</code> — 인터뷰 수, 행정 등록·단계, 인터뷰자별·지역별\n` +
    `• <code>/인터뷰 행정 [기간]</code> — 행정에 등록된 인터뷰 대상자를 현재 단계별로 (기본 전체, 개인정보 권한)\n` +
    `• <code>/인터뷰 미등록 [기간]</code> — 후속 O·보류인데 행정에 없는 사람 (개인정보 권한)\n• <code>/인터뷰 검색 이름</code> (개인정보 권한)\n` +
    `• <code>/인터뷰 특전대 [10.26] [향수|당터뷰]</code> — 특전대 기간(주차)에만, 그날 인터뷰한 사람을 특전대 결과로 (모두 발굴, 후속 O 는 찾기도. 미리보기 후 등록)\n` +
    `• 단체방에서 <code>/인터뷰 방등록</code> · <code>방해제</code>\n` +
    `• <code>/인터뷰 단계 [10.1~10.24]</code> — 찾등·합등한 인터뷰 대상자 (후속연결 O 포함, 기본 전체 기간, 기간을 적으면 그 기간 완료자만, 개인정보 권한)\n\n` +
    `<b>시스템 관리자</b>: <code>/인터뷰 권한 ID manager,pii [이름]</code> · <code>/인터뷰 보관기간 365</code>\n\n` +
    `행정 등록은 카운셀링 봇 행정 DB에서 <b>이름 + 인도자</b>(인도자가 없으면 지역)로 찾습니다. 같은 이름이 여러 명이면 연결하지 않고 '확인 필요'로 둡니다.`;

export function registerInterview(bot: Telegraf<any>) {
    registerModule({ key: MK, name: NAME, openMenu: (ctx) => dispatch(ctx), help: HELP });

    const run = (fn: (ctx: Ctx, next: () => Promise<void>) => Promise<unknown>) => async (ctx: Ctx, next: () => Promise<void>) => {
        try {
            await fn(ctx, next);
        } catch (err) {
            console.error(`[${NAME} 처리 에러]:`, err);
            await ctx.reply('⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하고, 계속되면 관리자에게 알려주세요.').catch(() => {});
        }
    };

    bot.hears(/^[\/!](?:인터뷰|iv)(?:@\w+)?(?:\s+(\S+))?(?:\s+([\s\S]+))?$/i, run((ctx) => dispatch(ctx, ctx.match[1] || '', ctx.match[2] || '')));
    bot.action(/^iv:a:(\S+)$/, run(async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        await dispatch(ctx, ctx.match[1]);
    }));
    bot.action(/^iv:sd:(p|ok):(\d{4}-\d{2}-\d{2}):([hda])$/, run(async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        const a = await access(ctx);
        if (!a.org || !hasPerm(a, 'manager')) return void (await ctx.reply('⛔ 관리자만 특전대 결과로 등록할 수 있습니다.'));
        const [, op, date, code] = ctx.match;
        if (op === 'p') return sidaPreview(ctx, a as A, '', { date, kind: kindOfCode(code) });
        await ctx.editMessageReplyMarkup(undefined).catch(() => {}); // 등록 버튼 두 번 누름 방지
        await sidaRegister(ctx, a as A, date, kindOfCode(code));
    }));
    bot.on('text', run(async (ctx, next) => {
        const text: string = ctx.message.text;
        if (/^[\/!]/.test(text) || !(await handleSheet(ctx, text))) return next();
    }));
}
