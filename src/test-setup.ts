// 테스트 공통 환경 — 다른 모듈보다 먼저 import. 실제 DB/텔레그램에는 연결하지 않음
import { PGlite } from '@electric-sql/pglite';

process.env.NEON_DATABASE_URL ||= 'postgres://unused@localhost/unused'; // db.ts 시작 검사 통과용 (쿼리는 PGlite 로)
process.env.ADMIN_IDS = '9000';

// PGlite(실제 Postgres WASM)를 pg Pool 처럼 쓰기 위한 어댑터 — 파라미터 없는 쿼리는 여러 문장(마이그레이션) 허용
export const pgliteQueryable = (pg: PGlite) => ({
    query: async (text: string, params?: unknown[]) =>
        params?.length ? pg.query<any>(text, params) : (await pg.exec(text)).at(-1) ?? { rows: [] },
});
