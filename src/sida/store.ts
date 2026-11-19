// 특전대 모듈 데이터: 취합 주차, 활동 가능 시간, 당일 결과, 선택 목록, 시간표 스냅샷
import { query } from '../db';
import { listMembers, listModuleSettings } from '../core/store';
import { DayInput, Slot, WEEKDAYS } from './time';
import { FIELD_KEYS, FieldKey, FormKind, REGIONS, ResultValues } from './result';

export const MODULE_KEY = 'special';

export interface Period {
    id: number;
    org_id: number;
    week_start: string; // YYYY-MM-DD 시작일 (아무 요일)
    days: number; // 시작일부터 며칠 (1~7). 요일별 데이터는 실제 요일(1=월…7=일)로 저장 — 7일 이하라 겹치지 않음
    status: 'open' | 'closed';
    extra_editors: number[];
    created_at: string;
}
const PERIOD_SELECT = `SELECT id, org_id, week_start::text AS week_start, days, status, extra_editors, created_at FROM cdabot_periods`;

// 대원이 지금 제출·수정할 수 있는 주차: 열린 주차 중 최신 (마감됐어도 수정 허용된 사람은 포함)
export async function getEditablePeriod(orgId: number, userId: number): Promise<Period | undefined> {
    return (
        await query(
            `${PERIOD_SELECT} WHERE org_id = $1 AND module_key = $2 AND (status = 'open' OR $3 = ANY(extra_editors))
             ORDER BY week_start DESC LIMIT 1;`,
            [orgId, MODULE_KEY, userId]
        )
    ).rows[0];
}

export async function getPeriodById(orgId: number, id: number): Promise<Period | undefined> {
    return (await query(`${PERIOD_SELECT} WHERE org_id = $1 AND module_key = $2 AND id = $3;`, [orgId, MODULE_KEY, id])).rows[0];
}

export async function getLatestPeriod(orgId: number): Promise<Period | undefined> {
    return (await query(`${PERIOD_SELECT} WHERE org_id = $1 AND module_key = $2 ORDER BY week_start DESC LIMIT 1;`, [orgId, MODULE_KEY])).rows[0];
}

// date 가 들어 있는 기간
export async function getPeriodAt(orgId: number, date: string): Promise<Period | undefined> {
    return (
        await query(`${PERIOD_SELECT} WHERE org_id = $1 AND module_key = $2 AND week_start <= $3::date AND $3::date < week_start + days ORDER BY week_start DESC LIMIT 1;`, [
            orgId,
            MODULE_KEY,
            date,
        ])
    ).rows[0];
}

// 다른 기간과 하루라도 겹치면 만들지 않음 (undefined)
export async function createPeriod(orgId: number, start: string, days = 7): Promise<Period | undefined> {
    const res = await query(
        `INSERT INTO cdabot_periods (org_id, module_key, week_start, days)
         SELECT $1, $2, $3::date, $4::int
         WHERE NOT EXISTS (SELECT 1 FROM cdabot_periods WHERE org_id = $1 AND module_key = $2 AND week_start < $3::date + $4::int AND $3::date < week_start + days)
         ON CONFLICT DO NOTHING RETURNING id;`,
        [orgId, MODULE_KEY, start, days]
    );
    return res.rows[0] ? getPeriodById(orgId, res.rows[0].id) : undefined;
}

// 시작일·일수 변경. 자기 말고 다른 기간과 겹치면 바꾸지 않음 (undefined)
export async function updatePeriod(orgId: number, id: number, start: string, days: number): Promise<Period | undefined> {
    const res = await query(
        `UPDATE cdabot_periods SET week_start = $4::date, days = $5::int
         WHERE org_id = $1 AND module_key = $2 AND id = $3
           AND NOT EXISTS (SELECT 1 FROM cdabot_periods o WHERE o.org_id = $1 AND o.module_key = $2 AND o.id <> $3 AND o.week_start < $4::date + $5::int AND $4::date < o.week_start + o.days)
         RETURNING id;`,
        [orgId, MODULE_KEY, id, start, days]
    );
    return res.rows[0] ? getPeriodById(orgId, id) : undefined;
}

export async function setPeriodStatus(orgId: number, periodId: number, status: 'open' | 'closed') {
    await query(
        `UPDATE cdabot_periods SET status = $3, closed_at = CASE WHEN $3 = 'closed' THEN NOW() ELSE NULL END
         WHERE org_id = $1 AND id = $2;`,
        [orgId, periodId, status]
    );
}

export async function addExtraEditor(orgId: number, periodId: number, userId: number) {
    await query(
        `UPDATE cdabot_periods SET extra_editors = array_append(extra_editors, $3)
         WHERE org_id = $1 AND id = $2 AND NOT ($3 = ANY(extra_editors));`,
        [orgId, periodId, userId]
    );
}

export type WeekDays = Record<number, DayInput>;

// 주차의 제출 전체: user_id → 요일별 입력
export async function getSubmissions(periodId: number): Promise<Map<number, { days: WeekDays; updated_at: string }>> {
    const res = await query(
        `SELECT s.user_id, s.unavailable_days, s.updated_at,
                COALESCE(json_agg(json_build_array(sl.weekday, sl.start_min, sl.end_min) ORDER BY sl.weekday, sl.start_min)
                         FILTER (WHERE sl.id IS NOT NULL), '[]') AS slots
         FROM cdabot_avail_submissions s LEFT JOIN cdabot_avail_slots sl ON sl.submission_id = s.id
         WHERE s.period_id = $1 GROUP BY s.id;`,
        [periodId]
    );
    const out = new Map<number, { days: WeekDays; updated_at: string }>();
    for (const r of res.rows) {
        const slots: [number, number, number][] = typeof r.slots === 'string' ? JSON.parse(r.slots) : r.slots;
        const days: WeekDays = {};
        for (const w of WEEKDAYS) {
            days[w] = {
                unavailable: r.unavailable_days.map(Number).includes(w),
                slots: slots.filter((s) => s[0] === w).map((s) => [s[1], s[2]] as Slot),
            };
        }
        out.set(r.user_id, { days, updated_at: r.updated_at });
    }
    return out;
}

// 제출 저장 (기존 구간은 한 문장 안에서 교체 — 트랜잭션 없이도 부분 저장 안 됨)
export async function saveSubmission(periodId: number, userId: number, days: WeekDays) {
    const w: number[] = [];
    const a: number[] = [];
    const b: number[] = [];
    const unavailable: number[] = [];
    for (const d of WEEKDAYS) {
        if (days[d]?.unavailable) unavailable.push(d);
        else for (const [s, e] of days[d]?.slots || []) w.push(d), a.push(s), b.push(e);
    }
    await query(
        `WITH s AS (
            INSERT INTO cdabot_avail_submissions (period_id, user_id, unavailable_days) VALUES ($1, $2, $3::smallint[])
            ON CONFLICT (period_id, user_id) DO UPDATE SET unavailable_days = EXCLUDED.unavailable_days, updated_at = NOW()
            RETURNING id
        ), d AS (
            DELETE FROM cdabot_avail_slots WHERE submission_id IN (SELECT id FROM s)
        )
        INSERT INTO cdabot_avail_slots (submission_id, weekday, start_min, end_min)
        SELECT s.id, x.w, x.a, x.b FROM s, unnest($4::smallint[], $5::smallint[], $6::smallint[]) AS x(w, a, b);`,
        [periodId, userId, unavailable, w, a, b]
    );
}

/* ====================== 당일 결과 ====================== */

export interface ResultRow extends Record<FieldKey, string | null> {
    id: number;
    org_id: number;
    user_id: number;
    kind: FormKind;
    submitter: string | null;
    activity_date: string;
    created_at: string;
    updated_at: string;
}

const RESULT_SELECT = `
    SELECT r.id, r.org_id, r.user_id, r.kind, m.display_name AS submitter, r.activity_date::text AS activity_date,
           ${FIELD_KEYS.map((k) => `r.${k}`).join(', ')},
           to_char(r.created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS created_at,
           to_char(r.updated_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS updated_at
    FROM cdabot_results r
    LEFT JOIN cdabot_memberships m ON m.org_id = r.org_id AND m.user_id = r.user_id AND m.module_key = '${MODULE_KEY}'`;

// 저장 성공 시 id, 같은 dedup_key 가 이미 있으면 null (중복 제출 방지)
export async function insertResult(r: {
    orgId: number;
    userId: number;
    kind: FormKind;
    date: string;
    values: ResultValues;
    dedupKey: string;
}): Promise<number | null> {
    const res = await query(
        `INSERT INTO cdabot_results (org_id, user_id, kind, activity_date, ${FIELD_KEYS.join(', ')}, dedup_key)
         VALUES ($1, $2, $3, $4, ${FIELD_KEYS.map((_, i) => `$${i + 5}`).join(', ')}, $${FIELD_KEYS.length + 5})
         ON CONFLICT (dedup_key) DO NOTHING RETURNING id;`,
        [r.orgId, r.userId, r.kind, r.date, ...FIELD_KEYS.map((k) => r.values[k] ?? null), r.dedupKey]
    );
    return res.rows[0]?.id ?? null;
}

// 같은 사람 결과가 이미 있는지 (발굴건 = 이름+연락처 뒷자리 4자리, 찾기건 = 이름+생년월일 숫자)
export async function isDuplicateResult(orgId: number, kind: FormKind, name: string, digits: string): Promise<boolean> {
    const digitsOf = `regexp_replace(COALESCE(${kind === 'dig' ? 'phone' : 'birth_date'}, ''), '\\D', '', 'g')`;
    const res = await query(
        `SELECT 1 FROM cdabot_results WHERE org_id = $1 AND kind = $2 AND deleted_at IS NULL AND name = $3
           AND ${kind === 'dig' ? `right(${digitsOf}, 4)` : digitsOf} = $4 LIMIT 1;`,
        [orgId, kind, name, digits]
    );
    return res.rows.length > 0;
}

// 같은 이름의 찾기건이 이미 있는지 (인터뷰 후속 O·행정 찾등 두 경로에서 한 사람이 두 번 들어가지 않게)
export async function findNameExists(orgId: number, name: string): Promise<boolean> {
    const res = await query(`SELECT 1 FROM cdabot_results WHERE org_id = $1 AND kind = 'find' AND deleted_at IS NULL AND name = $2 LIMIT 1;`, [orgId, name]);
    return res.rows.length > 0;
}

export async function getResult(orgId: number, id: number): Promise<ResultRow | undefined> {
    return (await query(`${RESULT_SELECT} WHERE r.org_id = $1 AND r.id = $2 AND r.deleted_at IS NULL;`, [orgId, id])).rows[0];
}

export async function savedKeys(keys: string[]): Promise<Set<string>> {
    return new Set((await query(`SELECT dedup_key FROM cdabot_results WHERE dedup_key = ANY($1::text[]);`, [keys])).rows.map((r) => r.dedup_key));
}

// 이 메시지(base)에서 저장된 줄이 하나라도 있는지 (줄마다 dedup_key = base:줄번호)
export async function messageSaved(base: string): Promise<boolean> {
    return (await query(`SELECT 1 FROM cdabot_results WHERE dedup_key LIKE $1 || ':%' LIMIT 1;`, [base])).rows.length > 0;
}

export async function updateResult(orgId: number, id: number, values: ResultValues) {
    await query(
        `UPDATE cdabot_results SET ${FIELD_KEYS.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = NOW()
         WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL;`,
        [orgId, id, ...FIELD_KEYS.map((k) => values[k] ?? null)]
    );
}

export async function deleteResult(orgId: number, id: number) {
    await query(`UPDATE cdabot_results SET deleted_at = NOW() WHERE org_id = $1 AND id = $2;`, [orgId, id]);
}

export interface ResultFilter {
    from?: string;
    to?: string;
    userId?: number;
    kind?: FormKind;
    fields?: Partial<Record<FieldKey, string>>; // 부분 일치
}

// shortcut: 조건에 맞는 행을 전부 가져와 메모리에서 집계·페이지 나눔 — 결과가 수만 건을 넘으면 SQL GROUP BY/LIMIT 로 전환
export async function listResults(orgId: number, f: ResultFilter = {}): Promise<ResultRow[]> {
    const where = ['r.org_id = $1', 'r.deleted_at IS NULL'];
    const params: unknown[] = [orgId];
    const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.from) add('r.activity_date >= ?', f.from);
    if (f.to) add('r.activity_date <= ?', f.to);
    if (f.userId) add('r.user_id = ?', f.userId);
    if (f.kind) add('r.kind = ?', f.kind);
    for (const [k, v] of Object.entries(f.fields || {})) {
        if (FIELD_KEYS.includes(k as FieldKey) && v) add(`r.${k} ILIKE ?`, `%${v.replace(/[\\%_]/g, '\\$&')}%`);
    }
    return (await query(`${RESULT_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.activity_date DESC, r.id DESC;`, params)).rows;
}

// 개인정보 보관기간이 설정된 조직: 기간이 지난 결과의 이름·연락처·생년월일 삭제 (통계용 다른 항목은 유지)
export async function purgeExpiredPii(): Promise<number> {
    let total = 0;
    for (const { org_id, settings } of await listModuleSettings(MODULE_KEY)) {
        const days = Number(settings.pii_retention_days);
        if (!days) continue;
        const res = await query(
            `UPDATE cdabot_results SET name = NULL, phone = NULL, birth_date = NULL, pii_purged_at = NOW()
             WHERE org_id = $1 AND pii_purged_at IS NULL AND activity_date < CURRENT_DATE - $2::int RETURNING id;`,
            [org_id, days]
        );
        total += res.rows.length;
    }
    return total;
}

/* ====================== 선택 목록 · 스냅샷 ====================== */

export async function listOptions(orgId: number): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const r of (await query(`SELECT field, value FROM cdabot_field_options WHERE org_id = $1 ORDER BY field, sort, id;`, [orgId])).rows) {
        (out[r.field] ||= []).push(r.value);
    }
    return out;
}

export async function addOption(orgId: number, field: string, value: string) {
    await query(
        `INSERT INTO cdabot_field_options (org_id, field, value, sort)
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM cdabot_field_options WHERE org_id = $1 AND field = $2))
         ON CONFLICT DO NOTHING;`,
        [orgId, field, value]
    );
}

export async function removeOption(orgId: number, field: string, value: string): Promise<boolean> {
    return (await query(`DELETE FROM cdabot_field_options WHERE org_id = $1 AND field = $2 AND value = $3 RETURNING id;`, [orgId, field, value])).rows.length > 0;
}

export async function saveSnapshot(periodId: number, userId: number | null, data: unknown) {
    await query(`INSERT INTO cdabot_schedule_snapshots (period_id, generated_by, data) VALUES ($1, $2, $3);`, [periodId, userId, JSON.stringify(data)]);
}

// 대원의 웹 명단(members) 지역·팀(구역 앞자리): 웹에서 텔레그램 계정과 연결한 명단이 있으면 그 사람, 없으면 이름이 같은 사람이 명단에 한 명뿐일 때 그 사람
// members 표가 없거나 읽기 실패하면 빈 값 (현황판은 지역 없이 그대로)
export type MemberInfo = { region: string | null; team: string | null };
export async function memberInfo(members: { telegram_id: string; display_name: string }[]): Promise<Map<string, MemberInfo>> {
    if (!members.length) return new Map();
    const r = await query(
        `SELECT t.tg, m."지역" AS region, NULLIF(split_part(m."구역", '-', 1), '') AS team
         FROM unnest($1::text[], $2::text[]) AS t(tg, name)
         CROSS JOIN LATERAL (SELECT COALESCE(
                (SELECT n.member_code FROM cdabot_online_names n WHERE n.poster_tg = t.tg::bigint),
                (SELECT min(x."고유번호") FROM members x WHERE x."이름" = t.name HAVING count(*) = 1)) AS code) c
         JOIN members m ON m."고유번호" = c.code;`,
        [members.map((m) => m.telegram_id), members.map((m) => m.display_name)]
    ).catch(() => ({ rows: [] as any[] }));
    return new Map(r.rows.map((x) => [x.tg as string, { region: x.region ?? null, team: x.team ?? null }]));
}

// 인도자 이름 → 특전대 대원. 대원 이름에 지역을 붙여 써도('노원이유진'·'노원/이유진'·'이유진(노원)') 같은 이름으로 봄
// 인터뷰 결과지와 단체방에 직접 올린 발/찾 줄 모두 이걸로 실적 대원을 정함
// 결과지(또는 줄)에 인도자지역이 있으면 대원 지역(웹 명단 연결, 없으면 이름에 쓴 지역)이 맞는 한 명. 맞는 사람이 없으면 지역을 모르는 대원이 한 명일 때만 그 사람
//   → 지역이 다른 동명이인(강북 이유진)에게 노원 결과가 가지 않음. 아무도 안 맞으면 등록하지 않고 '제외'로 알림
// info: 그 대원의 명단 지역·팀 (결과의 인도지역·인도팀으로 씀)
export async function guideOwners(orgId: number) {
    const members = await listMembers(orgId, MODULE_KEY);
    const info = await memberInfo(members);
    const plain = (n: string) => n.replace(/\([^)]*\)|[\s/·_-]+/g, '');
    const key = (n: string) => {
        const k = plain(n).replace(new RegExp(REGIONS.join('|'), 'g'), '');
        return k.length >= 2 ? k : plain(n);
    };
    const regionOf = (m: (typeof members)[number]) => info.get(m.telegram_id)?.region ?? REGIONS.find((r) => m.display_name.includes(r)) ?? null;
    const sameRegion = (a: string, b: string) => !!a && !!b && (a.includes(b) || b.includes(a)); // '강북구' = '강북'
    const pick = (m?: (typeof members)[number]) => m && { id: m.user_id, name: m.display_name, info: info.get(m.telegram_id) };
    return (g?: string | null, region?: string | null) => {
        if (!g) return undefined;
        const cands = members.filter((m) => key(m.display_name) === key(g));
        if (!region?.trim()) return cands.length === 1 ? pick(cands[0]) : undefined;
        const same = cands.filter((m) => sameRegion(regionOf(m) ?? '', region.trim()));
        if (same.length) return same.length === 1 ? pick(same[0]) : undefined;
        const unknown = cands.filter((m) => !regionOf(m));
        return unknown.length === 1 ? pick(unknown[0]) : undefined;
    };
}
