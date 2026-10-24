import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { getErrorMessage } from './utils';

const DB_URL = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!DB_URL) {
    console.error('❌ NEON_DATABASE_URL 환경 변수가 설정되지 않았습니다.');
    process.exit(1);
}

// Neon PostgreSQL 연결 풀 (counseling-bot과 같은 DB 사용 — 이 봇 테이블은 모두 cdabot_ 접두사)
const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
});

pool.on('error', (err: unknown) => {
    console.error('🚨 [Neon Pool 유휴 연결 에러]:', getErrorMessage(err));
});

// 모든 쿼리는 이 핸들을 거침 — 테스트에서 PGlite(실제 Postgres WASM)로 교체
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
