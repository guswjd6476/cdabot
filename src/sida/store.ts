// 특전대 모듈 데이터: 취합 주차, 활동 가능 시간, 당일 결과, 선택 목록, 시간표 스냅샷
import { query } from '../db';
import { listModuleSettings } from '../core/store';
import { DayInput, Slot, WEEKDAYS } from './time';
import { FIELD_KEYS, FieldKey, FormKind, ResultValues } from './result';

export const MODULE_KEY = 'special';

export interface Period {
    id: number;
    org_id: number;
    week_start: string; // YYYY-MM-DD (월요일)
    status: 'open' | 'closed';
    extra_editors: number[];
    created_at: string;
}
const PERIOD_SELECT = `SELECT id, org_id, week_start::text AS week_start, status, extra_editors, created_at FROM cdabot_periods`;

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

export async function getPeriodByWeek(orgId: number, weekStart: string): Promise<Period | undefined> {
    return (await query(`${PERIOD_SELECT} WHERE org_id = $1 AND module_key = $2 AND week_start = $3;`, [orgId, MODULE_KEY, weekStart])).rows[0];
}

export async function createPeriod(orgId: number, weekStart: string): Promise<Period | undefined> {
    const res = await query(
        `INSERT INTO cdabot_periods (org_id, module_key, week_start) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id;`,
        [orgId, MODULE_KEY, weekStart]
    );
    return res.rows[0] ? getPeriodByWeek(orgId, weekStart) : undefined;
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

export async function resultExists(dedupKey: string): Promise<boolean> {
    return (await query(`SELECT 1 FROM cdabot_results WHERE dedup_key = $1;`, [dedupKey])).rows.length > 0;
}

export async function getResult(orgId: number, id: number): Promise<ResultRow | undefined> {
    return (await query(`${RESULT_SELECT} WHERE r.org_id = $1 AND r.id = $2 AND r.deleted_at IS NULL;`, [orgId, id])).rows[0];
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
