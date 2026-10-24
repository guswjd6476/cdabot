import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { getErrorMessage } from './utils';

const DB_URL = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!DB_URL) {
    console.error('❌ NEON_DATABASE_URL 환경 변수가 설정되지 않았습니다.');
    process.exit(1);
}

// Neon PostgreSQL 연결 풀 (counseling-bot과 같은 DB 사용)
export const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
});

pool.on('error', (err: unknown) => {
    console.error('🚨 [Neon Pool 유휴 연결 에러]:', getErrorMessage(err));
});

// 시다봇 모듈 쿼리는 이 핸들을 거침 — 테스트에서 PGlite(실제 Postgres WASM)로 교체
export type Queryable = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };
let queryable: Queryable = pool;
export const setQueryable = (q: Queryable) => {
    queryable = q;
};
export const query = (text: string, params?: unknown[]) => queryable.query(text, params);

// migrations/*.sql 을 파일명 순서로 1회씩 적용 (적용 기록: cdabot_migrations)
export async function runMigrations() {
    await query(`CREATE TABLE IF NOT EXISTS cdabot_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW());`);
    const dir = path.join(__dirname, '..', 'migrations');
    const applied = new Set((await query(`SELECT name FROM cdabot_migrations;`)).rows.map((r) => r.name));
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        if (applied.has(file)) continue;
        await query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await query(`INSERT INTO cdabot_migrations (name) VALUES ($1);`, [file]);
        console.log(`✅ [DB 마이그레이션] ${file} 적용`);
    }
}

// 이 봇 전용 테이블은 cdabot_ 접두사 사용 — counseling-bot 테이블(counseling_chats 등)과 겹치지 않게
export const CHATS_TABLE = 'cdabot_chats';
export const META_TABLE = 'cdabot_meta';
export const REPORTS_TABLE = 'cdabot_reports';

export interface ChatRecord {
    chat_id: string;
    room_title: string;
    matched_member_id?: number | null;
    meeting_date?: string | null; // '' / '미정' / '중단' / 'YYYY-MM-DD'
    meeting_time?: string | null;
    note?: string | null;
    role?: string | null; // 방 역할 (예: 특전대, 온라인전도) — 이 값이 있어야 보고를 취합
    last_message_at?: string | null;
    created_at: string;
    updated_at: string;
}

// 시작 시 테이블·컬럼 자동 생성 (컬럼 추가는 ADD COLUMN IF NOT EXISTS로 계속 이어 붙이기)
export async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ${CHATS_TABLE} (
                chat_id TEXT PRIMARY KEY,
                room_title TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await pool.query(`
            ALTER TABLE ${CHATS_TABLE}
            ADD COLUMN IF NOT EXISTS matched_member_id INTEGER,
            ADD COLUMN IF NOT EXISTS meeting_date VARCHAR(20),
            ADD COLUMN IF NOT EXISTS meeting_time VARCHAR(20),
            ADD COLUMN IF NOT EXISTS note TEXT,
            ADD COLUMN IF NOT EXISTS role VARCHAR(50),
            ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
        `);
        // 보고 1건 = 메시지 1개 (수정하면 같은 행 갱신). report_date는 meeting_date처럼 'YYYY-MM-DD' 문자열
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ${REPORTS_TABLE} (
                id SERIAL PRIMARY KEY,
                chat_id TEXT NOT NULL,
                message_id BIGINT NOT NULL,
                role VARCHAR(50) NOT NULL,
                report_date VARCHAR(10) NOT NULL,
                user_id TEXT,
                user_name TEXT,
                data JSONB NOT NULL,
                raw_text TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (chat_id, message_id)
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${REPORTS_TABLE}_role_date_idx ON ${REPORTS_TABLE} (role, report_date);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT);`);
        console.log(`✅ [DB 점검] ${CHATS_TABLE} 테이블 점검 완료`);
    } catch (err: unknown) {
        console.error('⚠️ [DB 점검 경고]:', getErrorMessage(err));
    }
    try {
        await runMigrations();
    } catch (err: unknown) {
        console.error('🚨 [DB 마이그레이션 실패] 시다봇 기능이 동작하지 않을 수 있습니다:', getErrorMessage(err));
    }
}

// 방 기본 레코드 보장 (+ 마지막 대화 시각 기록 — updated_at은 일정·상태가 바뀔 때만 갱신)
export async function ensureChatRecord(chatId: string | number, title: string): Promise<ChatRecord> {
    const res = await pool.query(
        `INSERT INTO ${CHATS_TABLE} (chat_id, room_title, last_message_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (chat_id) DO UPDATE SET room_title = EXCLUDED.room_title, last_message_at = NOW()
         RETURNING *;`,
        [String(chatId), title || '대화방']
    );
    return res.rows[0];
}

export async function getChat(chatId: string | number): Promise<ChatRecord | undefined> {
    const res = await pool.query(`SELECT * FROM ${CHATS_TABLE} WHERE chat_id = $1 LIMIT 1;`, [String(chatId)]);
    return res.rows[0];
}

export async function getAllChats(): Promise<ChatRecord[]> {
    const res = await pool.query(`SELECT * FROM ${CHATS_TABLE} ORDER BY created_at ASC;`);
    return res.rows;
}

// 방 정보 부분 업데이트 (키는 코드에서만 넘기므로 컬럼명 화이트리스트로 제한)
const UPDATABLE_COLUMNS = ['room_title', 'matched_member_id', 'meeting_date', 'meeting_time', 'note', 'role'] as const;

export async function updateChat(chatId: string | number, patch: Partial<ChatRecord>) {
    const keys = Object.keys(patch).filter((k) => (UPDATABLE_COLUMNS as readonly string[]).includes(k));
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    await pool.query(
        `UPDATE ${CHATS_TABLE} SET ${sets.join(', ')}, updated_at = NOW() WHERE chat_id = $1;`,
        [String(chatId), ...keys.map((k) => (patch as any)[k])]
    );
}

/* ====================== 📝 역할별 보고 ====================== */

export interface ReportRecord {
    chat_id: string;
    room_title?: string;
    user_name?: string | null;
    data: Record<string, number>;
}

// 보고 저장 (같은 메시지를 수정하면 덮어씀) — 새 보고면 true
export async function upsertReport(r: {
    chatId: string | number;
    messageId: number;
    role: string;
    reportDate: string;
    userId?: number;
    userName?: string;
    data: Record<string, number>;
    rawText: string;
}): Promise<boolean> {
    const res = await pool.query(
        `INSERT INTO ${REPORTS_TABLE} (chat_id, message_id, role, report_date, user_id, user_name, data, raw_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (chat_id, message_id) DO UPDATE SET data = EXCLUDED.data, raw_text = EXCLUDED.raw_text, updated_at = NOW()
         RETURNING (xmax = 0) AS inserted;`,
        [String(r.chatId), r.messageId, r.role, r.reportDate, r.userId ? String(r.userId) : null, r.userName || null, JSON.stringify(r.data), r.rawText]
    );
    return res.rows[0].inserted;
}

export async function getReports(role: string, reportDate: string): Promise<ReportRecord[]> {
    const res = await pool.query(
        `SELECT r.chat_id, c.room_title, r.user_name, r.data
         FROM ${REPORTS_TABLE} r LEFT JOIN ${CHATS_TABLE} c ON c.chat_id = r.chat_id
         WHERE r.role = $1 AND r.report_date = $2
         ORDER BY c.room_title, r.created_at;`,
        [role, reportDate]
    );
    return res.rows;
}

export async function getChatsByRole(role: string): Promise<ChatRecord[]> {
    const res = await pool.query(`SELECT * FROM ${CHATS_TABLE} WHERE role = $1 ORDER BY room_title;`, [role]);
    return res.rows;
}

export async function getRoles(): Promise<string[]> {
    const res = await pool.query(`SELECT DISTINCT role FROM ${CHATS_TABLE} WHERE role IS NOT NULL ORDER BY role;`);
    return res.rows.map((row) => row.role);
}

// members 테이블에서 사람 찾기 (counseling-bot과 동일 규칙)
export async function findMemberFromDB(name: string, region: string, teamRaw: string) {
    const team = teamRaw.replace(/팀/g, '').trim();
    const res = await pool.query(
        `SELECT "고유번호", "이름", "지역", "구역"
         FROM members
         WHERE "이름" = $1
           AND ("지역" LIKE '%' || $2 || '%' OR $2 LIKE '%' || "지역" || '%')
           AND (COALESCE("구역", '') LIKE $3 || '-%' OR COALESCE("구역", '') LIKE '%' || $3 || '%')
         LIMIT 1;`,
        [name, region, team]
    );
    return res.rows[0] || null;
}
