// 공통 엔진 데이터: 사용자, 조직, 역할 멤버십, 모듈 설정, 감사 로그, 입력 세션
import { query } from '../db';

export type Perm = 'member' | 'manager' | 'pii';
export const PERMS: Perm[] = ['member', 'manager', 'pii'];

export interface Membership {
    id: number;
    org_id: number;
    org_name: string;
    user_id: number;
    telegram_id: string;
    module_key: string;
    display_name: string;
    perms: Perm[];
    status: 'pending' | 'active' | 'inactive' | 'rejected';
}

const MEMBER_SELECT = `
    SELECT m.id, m.org_id, o.name AS org_name, m.user_id, u.telegram_id::text AS telegram_id, m.module_key,
           m.display_name, m.perms, m.status
    FROM cdabot_memberships m JOIN cdabot_users u ON u.id = m.user_id JOIN cdabot_orgs o ON o.id = m.org_id`;

export async function upsertUser(telegramId: number | string, tgName: string): Promise<{ id: number }> {
    const res = await query(
        `INSERT INTO cdabot_users (telegram_id, tg_name) VALUES ($1, $2)
         ON CONFLICT (telegram_id) DO UPDATE SET tg_name = COALESCE(EXCLUDED.tg_name, cdabot_users.tg_name), updated_at = NOW()
         RETURNING id;`,
        [String(telegramId), tgName || null]
    );
    return res.rows[0];
}

export async function listOrgs(): Promise<{ id: number; name: string }[]> {
    return (await query(`SELECT id, name FROM cdabot_orgs ORDER BY id;`)).rows;
}

export async function createOrg(name: string): Promise<{ id: number; name: string } | undefined> {
    return (await query(`INSERT INTO cdabot_orgs (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id, name;`, [name])).rows[0];
}

export async function getUserMemberships(userId: number, moduleKey: string): Promise<Membership[]> {
    return (await query(`${MEMBER_SELECT} WHERE m.user_id = $1 AND m.module_key = $2 ORDER BY m.org_id;`, [userId, moduleKey])).rows;
}

export async function listMembers(orgId: number, moduleKey: string, statuses = ['active']): Promise<Membership[]> {
    return (
        await query(`${MEMBER_SELECT} WHERE m.org_id = $1 AND m.module_key = $2 AND m.status = ANY($3) ORDER BY m.display_name, m.id;`, [
            orgId,
            moduleKey,
            statuses,
        ])
    ).rows;
}

export async function getMember(orgId: number, moduleKey: string, by: { id?: number; telegramId?: string }): Promise<Membership | undefined> {
    const [col, val] = by.id ? ['m.id', by.id] : ['u.telegram_id::text', String(by.telegramId)];
    return (await query(`${MEMBER_SELECT} WHERE m.org_id = $1 AND m.module_key = $2 AND ${col} = $3 LIMIT 1;`, [orgId, moduleKey, val])).rows[0];
}

// 가입 요청(pending) 또는 관리자 직접 등록(active). 이미 있으면 거절/비활성 상태일 때만 요청 상태로 되돌림
export async function upsertMembership(orgId: number, userId: number, moduleKey: string, displayName: string, status: 'pending' | 'active') {
    const res = await query(
        `INSERT INTO cdabot_memberships (org_id, user_id, module_key, display_name, status) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, user_id, module_key) DO UPDATE SET
             display_name = CASE WHEN $5 = 'active' THEN EXCLUDED.display_name ELSE cdabot_memberships.display_name END,
             status = CASE WHEN $5 = 'active' THEN 'active'
                           WHEN cdabot_memberships.status = 'rejected' THEN 'pending' ELSE cdabot_memberships.status END,
             updated_at = NOW()
         RETURNING id;`,
        [orgId, userId, moduleKey, displayName, status]
    );
    return (await getMember(orgId, moduleKey, { id: res.rows[0].id }))!;
}

// org_id 조건을 항상 함께 걸어 다른 조직 멤버십은 바꿀 수 없게 함
export async function updateMembership(orgId: number, membershipId: number, patch: { status?: string; perms?: Perm[]; display_name?: string }) {
    const res = await query(
        `UPDATE cdabot_memberships SET status = COALESCE($3, status), perms = COALESCE($4, perms),
             display_name = COALESCE($5, display_name), updated_at = NOW()
         WHERE org_id = $1 AND id = $2 RETURNING id;`,
        [orgId, membershipId, patch.status ?? null, patch.perms ?? null, patch.display_name ?? null]
    );
    return res.rows.length > 0;
}

// 등록된 단체방 (chat_id → 조직)
export async function getGroupOrg(chatId: number, moduleKey: string): Promise<number | undefined> {
    return (await query(`SELECT org_id FROM cdabot_group_chats WHERE chat_id = $1 AND module_key = $2;`, [String(chatId), moduleKey])).rows[0]?.org_id;
}

export async function listGroupChats(orgId: number, moduleKey: string): Promise<string[]> {
    return (await query(`SELECT chat_id::text AS id FROM cdabot_group_chats WHERE org_id = $1 AND module_key = $2;`, [orgId, moduleKey])).rows.map((r) => r.id);
}

export async function setGroupOrg(chatId: number, moduleKey: string, orgId: number | null, title?: string, by?: number) {
    if (orgId === null) return void (await query(`DELETE FROM cdabot_group_chats WHERE chat_id = $1 AND module_key = $2;`, [String(chatId), moduleKey]));
    await query(
        `INSERT INTO cdabot_group_chats (chat_id, module_key, org_id, title, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (chat_id, module_key) DO UPDATE SET org_id = EXCLUDED.org_id, title = EXCLUDED.title;`,
        [String(chatId), moduleKey, orgId, title || null, by || null]
    );
}

// 자동 등록: 처음이면 대원(active)으로, 가입 대기였으면 활성화. 비활성·거절된 사람은 그대로 둠. 새로 활성화되면 true
export async function autoEnroll(orgId: number, userId: number, moduleKey: string, displayName: string): Promise<boolean> {
    const res = await query(
        `INSERT INTO cdabot_memberships (org_id, user_id, module_key, display_name, status) VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (org_id, user_id, module_key) DO UPDATE SET status = 'active', updated_at = NOW()
         WHERE cdabot_memberships.status = 'pending'
         RETURNING id;`,
        [orgId, userId, moduleKey, displayName]
    );
    return res.rows.length > 0;
}

export async function getSettings(orgId: number, moduleKey: string): Promise<Record<string, any>> {
    return (await query(`SELECT settings FROM cdabot_modules WHERE org_id = $1 AND module_key = $2;`, [orgId, moduleKey])).rows[0]?.settings || {};
}

export async function setSetting(orgId: number, moduleKey: string, key: string, value: unknown) {
    await query(
        `INSERT INTO cdabot_modules (org_id, module_key, settings) VALUES ($1, $2, jsonb_build_object($3::text, $4::jsonb))
         ON CONFLICT (org_id, module_key) DO UPDATE SET settings = cdabot_modules.settings || EXCLUDED.settings;`,
        [orgId, moduleKey, key, JSON.stringify(value)]
    );
}

export async function listModuleSettings(moduleKey: string): Promise<{ org_id: number; settings: Record<string, any> }[]> {
    return (await query(`SELECT org_id, settings FROM cdabot_modules WHERE module_key = $1;`, [moduleKey])).rows;
}

export async function audit(orgId: number | null, actorUserId: number | null, action: string, target?: string | number | null, detail?: unknown) {
    await query(`INSERT INTO cdabot_audit_logs (org_id, actor_user_id, action, target, detail) VALUES ($1, $2, $3, $4, $5);`, [
        orgId,
        actorUserId,
        action,
        target === undefined || target === null ? null : String(target),
        detail === undefined ? null : JSON.stringify(detail),
    ]);
}

export async function loadSession(telegramId: number): Promise<Record<string, any>> {
    return (await query(`SELECT data FROM cdabot_sessions WHERE telegram_id = $1;`, [String(telegramId)])).rows[0]?.data || {};
}

export async function saveSession(telegramId: number, data: Record<string, any>) {
    await query(
        `INSERT INTO cdabot_sessions (telegram_id, data, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (telegram_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW();`,
        [String(telegramId), JSON.stringify(data)]
    );
}
