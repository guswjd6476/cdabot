// 당일 결과 양식 (순수 함수). 외부 AI 없이 '항목: 값' 줄 단위로 정리하고, 모르는 값은 추측하지 않음

export const RESULT_FIELDS = [
    { key: 'bal', label: '발', aliases: ['발'] },
    { key: 'name', label: '이름', aliases: ['이름', '성명'] },
    { key: 'phone', label: '연락처', aliases: ['연락처', '전화', '전화번호', '번호', '핸드폰', '휴대폰', '폰'] },
    { key: 'age_group', label: '생년 구분', aliases: ['생년', '생년구분', '나이', '연령', '연령대'] },
    { key: 'gender', label: '성별', aliases: ['성별'] },
    { key: 'region', label: '인도지역', aliases: ['인도지역', '지역'] },
    { key: 'team', label: '인도팀', aliases: ['인도팀', '팀'] },
    { key: 'guide', label: '인도자', aliases: ['인도자'] },
    { key: 'tool', label: '도구', aliases: ['도구'] },
] as const;

export type FieldKey = (typeof RESULT_FIELDS)[number]['key'];
export type ResultValues = Partial<Record<FieldKey, string | null>>; // null = 미입력으로 확인됨
export const FIELD_KEYS = RESULT_FIELDS.map((f) => f.key) as FieldKey[];
export const fieldLabel = (k: FieldKey) => RESULT_FIELDS.find((f) => f.key === k)!.label;

export const AGE_GROUPS = ['20대 초', '20대 중', '20대 후', '30대', '모름'];
// 관리자가 목록을 관리하는 항목 (gender 는 목록 밖 값이면 다시 확인, 나머지는 직접 입력 허용)
export const OPTION_FIELDS: FieldKey[] = ['gender', 'region', 'team', 'guide', 'tool'];
export const PII_FIELDS: FieldKey[] = ['name', 'phone'];

const squash = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');

export function fieldByAlias(raw: string): FieldKey | null {
    const k = squash(raw);
    return RESULT_FIELDS.find((f) => (f.aliases as readonly string[]).includes(k))?.key ?? null;
}

// 자유 형식 → 필드별 값. 같은 항목이 서로 다른 값으로 두 번 나오면 conflicts 로 빼서 다시 질문
export function parseFreeForm(text: string): { values: ResultValues; conflicts: FieldKey[]; recognized: number } {
    const values: ResultValues = {};
    const conflicts = new Set<FieldKey>();
    let recognized = 0;
    for (const line of text.normalize('NFKC').split('\n')) {
        const m = line.match(/^\s*(?:\d+[.)]\s*)?[-•·*]?\s*([^:]+?)\s*:\s*(.*?)\s*$/);
        if (!m) continue;
        const key = fieldByAlias(m[1]);
        if (!key) continue;
        recognized++;
        if (!m[2]) continue; // 값이 비어 있으면 누락으로 둠
        if (values[key] !== undefined && values[key] !== m[2]) conflicts.add(key);
        else values[key] = m[2];
    }
    for (const k of conflicts) delete values[k];
    return { values, conflicts: [...conflicts], recognized };
}

export function normalizePhone(raw: string): string | null {
    const d = raw.normalize('NFKC').replace(/[\s\-.()]/g, '');
    if (!/^\d+$/.test(d)) return null;
    if (/^01[016789]\d{7,8}$/.test(d)) return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
    if (/^0\d{8,10}$/.test(d)) return d; // 유선 등은 숫자 그대로
    return null;
}

// 한 항목 검증. ok=false 면 reason 을 보여주고 그 항목만 다시 질문
export function validateField(key: FieldKey, raw: string, options: string[] = []): { ok: true; value: string } | { ok: false; reason: string } {
    const v = raw.normalize('NFKC').trim();
    if (!v) return { ok: false, reason: '값이 비어 있습니다.' };
    if (v.length > 100) return { ok: false, reason: '100자 이하로 입력해주세요.' };
    if (key === 'phone') {
        const p = normalizePhone(v);
        return p ? { ok: true, value: p } : { ok: false, reason: `연락처 형식을 확인해주세요: "${v}" (예: 010-1234-5678)` };
    }
    if (key === 'age_group') {
        const hit = AGE_GROUPS.find((a) => squash(a) === squash(v));
        return hit ? { ok: true, value: hit } : { ok: false, reason: `생년 구분은 ${AGE_GROUPS.join(' / ')} 중에서 선택해주세요. (입력: "${v}")` };
    }
    if (key === 'gender' && options.length) {
        const hit = options.find((o) => squash(o) === squash(v));
        return hit ? { ok: true, value: hit } : { ok: false, reason: `성별은 ${options.join(' / ')} 중에서 선택해주세요. (입력: "${v}")` };
    }
    // 목록 항목은 표기만 맞춰주고(공백 차이), 목록에 없어도 직접 입력값 그대로 허용
    const hit = options.find((o) => squash(o) === squash(v));
    return { ok: true, value: hit ?? v };
}

export function maskName(n?: string | null): string {
    if (!n) return '';
    const c = [...n];
    return c.length <= 1 ? '*' : c.length === 2 ? `${c[0]}*` : `${c[0]}${'*'.repeat(c.length - 2)}${c[c.length - 1]}`;
}

// 항목별 건수 (미입력은 '(미입력)' 으로 따로)
export function countBy<T extends Record<string, any>>(rows: T[], key: keyof T): [string, number][] {
    const m = new Map<string, number>();
    for (const r of rows) {
        const v = r[key] ? String(r[key]) : '(미입력)';
        m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => (a[0] === '(미입력)' ? 1 : b[0] === '(미입력)' ? -1 : b[1] - a[1]));
}

export const missingCount = (r: Record<string, any>) => FIELD_KEYS.filter((k) => !r[k]).length;

// 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM + CRLF. 수식 주입(=,+,@ 로 시작) 방지
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): Buffer {
    const cell = (v: string | number | null | undefined) => {
        let s = v === null || v === undefined ? '' : String(v);
        if (/^[=+@\t\r]/.test(s) || /^-[^\d]/.test(s)) s = `'${s}`;
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
    return Buffer.from('﻿' + body + '\r\n', 'utf8');
}
