// 인터뷰 추적 데이터 + 카운셀링 봇 행정 DB(students·members) 조회. students 는 읽기만 함
import { query } from '../db';
import { listModuleSettings } from '../core/store';
import { FollowUp, InterviewEntry, InterviewKind } from './parse';

export const MODULE_KEY = 'interview';

export interface InterviewRow {
    id: number;
    interview_date: string;
    kind: InterviewKind;
    name: string | null;
    follow_up: FollowUp | null;
    region: string | null;
    guides: string[];
    interviewer: string | null;
    phone: string | null;
    birth_date: string | null;
    memo: string | null;
    student_id: string | null;
    match_note: 'none' | 'multi' | null;
    poster: string | null;
    // 행정 (students 를 읽을 수 있을 때만)
    stage?: string | null;
    dropped?: boolean;
    chat_date?: string | null; // 찾_완료일 (찾등)
    hap_date?: string | null; // 합_완료일 (합등)
}

// 이름 + 인도자(없으면 지역)로 행정 대상자 찾기 — 카운셀링 봇 /최초등록과 같은 기준. 한 명일 때만 연결
export async function findStudent(e: { name: string; guides: string[]; region: string | null }): Promise<{ id: string | null; note: 'none' | 'multi' | null }> {
    const rows = (
        await query(
            `SELECT s.id::text AS id FROM students s
             LEFT JOIN members m ON s."인도자_고유번호" = m."고유번호"
             WHERE s."이름" = $1
               AND (cardinality($2::text[]) = 0 OR m."이름" = ANY($2::text[]))
               AND (cardinality($2::text[]) > 0 OR $3::text IS NULL OR m."지역" LIKE '%' || $3 || '%' OR $3 LIKE '%' || m."지역" || '%')
             LIMIT 2;`,
            [e.name, e.guides, e.region]
        )
    ).rows;
    return rows.length === 1 ? { id: rows[0].id, note: null } : { id: null, note: rows.length ? 'multi' : 'none' };
}

const nameKey = (n: string) => n.replace(/\s+/g, '');

// 같은 날 같은 이름이면 덮어씀 (행정 연결은 유지). 저장 후 행정 연결 시도
export async function saveInterviews(orgId: number, userId: number, date: string, kind: InterviewKind, entries: InterviewEntry[]) {
    let created = 0;
    for (const x of entries) {
        const res = await query(
            `INSERT INTO cdabot_interviews (org_id, user_id, interview_date, name, name_key, follow_up, region, guides, interviewer, phone, birth_date, memo, kind)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (org_id, interview_date, name_key) DO UPDATE SET
                 user_id = EXCLUDED.user_id, name = EXCLUDED.name, follow_up = EXCLUDED.follow_up, region = EXCLUDED.region,
                 guides = EXCLUDED.guides, interviewer = EXCLUDED.interviewer, phone = EXCLUDED.phone,
                 birth_date = EXCLUDED.birth_date, memo = EXCLUDED.memo, kind = EXCLUDED.kind, updated_at = NOW()
             RETURNING (xmax = 0) AS created;`,
            [orgId, userId, date, x.name, nameKey(x.name), x.followUp, x.region, x.guides, x.interviewer, x.phone, x.birthDate, x.memo, kind]
        );
        if (res.rows[0]?.created) created++;
    }
    const link = await linkPending(orgId);
    return { created, updated: entries.length - created, linkError: link.error };
}

// 아직 행정에 연결 안 된 건을 다시 찾음 (저장할 때 + 현황 볼 때). 행정 DB를 못 읽으면 error
// shortcut: 건마다 쿼리 1번 (최근 180일만) — 미연결이 수천 건 쌓여 느려지면 한 번의 JOIN 쿼리로 바꿀 것
export async function linkPending(orgId: number): Promise<{ linked: number; error?: string }> {
    const rows = (
        await query(
            `SELECT id, name, guides, region FROM cdabot_interviews
             WHERE org_id = $1 AND student_id IS NULL AND name IS NOT NULL AND interview_date >= CURRENT_DATE - 180;`,
            [orgId]
        )
    ).rows;
    let linked = 0;
    try {
        for (const r of rows) {
            const m = await findStudent(r);
            await query(`UPDATE cdabot_interviews SET student_id = $2, match_note = $3 WHERE id = $1;`, [r.id, m.id, m.note]);
            if (m.id) linked++;
        }
    } catch (err) {
        return { linked, error: err instanceof Error ? err.message : String(err) };
    }
    return { linked };
}

const SELECT = `
    SELECT i.id, i.interview_date::text AS interview_date, i.kind, i.name, i.follow_up, i.region, i.guides, i.interviewer,
           i.phone, i.birth_date, i.memo, i.student_id, i.match_note, mb.display_name AS poster`;
const FROM = `
    FROM cdabot_interviews i
    LEFT JOIN cdabot_memberships mb ON mb.org_id = i.org_id AND mb.user_id = i.user_id AND mb.module_key = '${MODULE_KEY}'`;

export interface InterviewFilter {
    from?: string;
    to?: string;
    name?: string;
    kind?: InterviewKind;
}

// 행정 단계는 저장하지 않고 볼 때마다 students 에서 읽음 (행정이 바뀌면 바로 반영). 못 읽으면 adminError
export async function listInterviews(orgId: number, f: InterviewFilter = {}): Promise<{ rows: InterviewRow[]; adminError?: string }> {
    const where = ['i.org_id = $1'];
    const params: unknown[] = [orgId];
    const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.from) add('i.interview_date >= ?', f.from);
    if (f.to) add('i.interview_date <= ?', f.to);
    if (f.kind) add('i.kind = ?', f.kind);
    if (f.name) add('i.name ILIKE ?', `%${f.name.replace(/[\\%_]/g, '\\$&')}%`);
    const tail = `WHERE ${where.join(' AND ')} ORDER BY i.interview_date DESC, i.id DESC;`;
    try {
        const rows = (
            await query(
                `${SELECT}, s."단계" AS stage, s."탈락" AS dropped_raw,
                        to_char(s."찾_완료일", 'YYYY-MM-DD') AS chat_date, to_char(s."합_완료일", 'YYYY-MM-DD') AS hap_date ${FROM} LEFT JOIN students s ON s.id::text = i.student_id ${tail}`,
                params
            )
        ).rows;
        // 탈락: 탈락 칸에 값이 있거나 단계에 '탈락' (카운셀링 봇과 같은 기준)
        return { rows: rows.map(({ dropped_raw, ...r }) => ({ ...r, dropped: !!dropped_raw || String(r.stage ?? '').includes('탈락') })) };
    } catch (err) {
        return { rows: (await query(`${SELECT} ${FROM} ${tail}`, params)).rows, adminError: err instanceof Error ? err.message : String(err) };
    }
}

// 보관기간이 지난 인터뷰의 이름·연락처·생년월일·메모 삭제 (건수·후속 상태·행정 연결은 통계용으로 유지)
export async function purgeExpiredInterviews(): Promise<number> {
    let total = 0;
    for (const { org_id, settings } of await listModuleSettings(MODULE_KEY)) {
        const days = Number(settings.pii_retention_days);
        if (!days) continue;
        const res = await query(
            `UPDATE cdabot_interviews SET name = NULL, name_key = 'purged:' || id, phone = NULL, birth_date = NULL, memo = NULL, pii_purged_at = NOW()
             WHERE org_id = $1 AND pii_purged_at IS NULL AND interview_date < CURRENT_DATE - $2::int RETURNING id;`,
            [org_id, days]
        );
        total += res.rows.length;
    }
    return total;
}
