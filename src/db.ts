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

// 이 봇 전용 테이블은 cdabot_ 접두사 사용 — counseling-bot 테이블(counseling_chats 등)과 겹치지 않게
export const CHATS_TABLE = 'cdabot_chats';
export const META_TABLE = 'cdabot_meta';

export interface ChatRecord {
    chat_id: string;
    room_title: string;
    matched_member_id?: number | null;
    meeting_date?: string | null; // '' / '미정' / '중단' / 'YYYY-MM-DD'
    meeting_time?: string | null;
    note?: string | null;
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
            ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
        `);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT);`);
        console.log(`✅ [DB 점검] ${CHATS_TABLE} 테이블 점검 완료`);
    } catch (err: unknown) {
        console.error('⚠️ [DB 점검 경고]:', getErrorMessage(err));
    }
}

// 방 기본 레코드 보장 (+ 마지막 대화 시각 기록 — updated_at은 일정·상태가 바뀔 때만 갱신)
export async function ensureChatRecord(chatId: string | number, title: string) {
    await pool.query(
        `INSERT INTO ${CHATS_TABLE} (chat_id, room_title, last_message_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (chat_id) DO UPDATE SET room_title = EXCLUDED.room_title, last_message_at = NOW();`,
        [String(chatId), title || '대화방']
    );
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
const UPDATABLE_COLUMNS = ['room_title', 'matched_member_id', 'meeting_date', 'meeting_time', 'note'] as const;

export async function updateChat(chatId: string | number, patch: Partial<ChatRecord>) {
    const keys = Object.keys(patch).filter((k) => (UPDATABLE_COLUMNS as readonly string[]).includes(k));
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    await pool.query(
        `UPDATE ${CHATS_TABLE} SET ${sets.join(', ')}, updated_at = NOW() WHERE chat_id = $1;`,
        [String(chatId), ...keys.map((k) => (patch as any)[k])]
    );
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
