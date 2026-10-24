// 당일 결과 양식 (순수 함수). 외부 AI 없이 '발/…', '찾/…' 한 줄 양식을 '/' 로 나눠 정리하고, 모르는 값은 추측하지 않음
//   발굴건: 발/이름/연락처/생년(20대초·중·후,30대,모름)/성별/인도지역/인도팀/인도자/도구/+2차만남일시,장소
//   찾기건: 찾/이름/생년월일/인도지역/인도팀/인도자/목표월

export const RESULT_FIELDS = [
    { key: 'name', label: '이름' },
    { key: 'phone', label: '연락처' },
    { key: 'age_group', label: '생년 구분' },
    { key: 'birth_date', label: '생년월일' },
    { key: 'gender', label: '성별' },
    { key: 'region', label: '인도지역' },
    { key: 'team', label: '인도팀' },
    { key: 'guide', label: '인도자' },
    { key: 'tool', label: '도구' },
    { key: 'meet_at', label: '2차 만남 일시' },
    { key: 'meet_place', label: '2차 만남 장소' },
    { key: 'target_month', label: '목표월' },
] as const;

export type FieldKey = (typeof RESULT_FIELDS)[number]['key'];
export type ResultValues = Partial<Record<FieldKey, string | null>>; // null = 미입력으로 확인됨
export const FIELD_KEYS = RESULT_FIELDS.map((f) => f.key) as FieldKey[];
export const fieldLabel = (k: FieldKey) => RESULT_FIELDS.find((f) => f.key === k)!.label;

export type FormKind = 'dig' | 'find';
export const FORMS: Record<FormKind, { label: string; marker: string; fields: FieldKey[]; template: string }> = {
    dig: {
        label: '발굴건',
        marker: '발',
        fields: ['name', 'phone', 'age_group', 'gender', 'region', 'team', 'guide', 'tool', 'meet_at', 'meet_place'],
        template: '발/이름/연락처/생년(20대초·중·후,30대,모름)/성별/인도지역/인도팀/인도자/도구/+2차만남일시,장소',
    },
    find: {
        label: '찾기건',
        marker: '찾',
        fields: ['name', 'birth_date', 'region', 'team', 'guide', 'target_month'],
        template: '찾/이름/생년월일/인도지역/인도팀/인도자/목표월',
    },
};
export const formOf = (k?: string | null): FormKind => (k === 'find' ? 'find' : 'dig');

export const AGE_GROUPS = ['20대 초', '20대 중', '20대 후', '30대', '모름'];
// 관리자가 목록을 관리하는 항목 (gender 는 목록 밖 값이면 다시 확인, 나머지는 직접 입력 허용)
export const OPTION_FIELDS: FieldKey[] = ['gender', 'region', 'team', 'guide', 'tool'];
export const PII_FIELDS: FieldKey[] = ['name', 'phone', 'birth_date'];

const squash = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');

export interface ParsedForm {
    kind: FormKind;
    values: ResultValues; // 비어 있는 칸은 넣지 않음 → 다시 질문
    notes: string[];
}

// 메시지에서 '발/' 또는 '찾/' 로 시작하는 줄을 찾아 양식별로 정리 ('❗️발굴건' 같은 제목 줄은 무시)
export function parseSlashForms(text: string): ParsedForm[] {
    const out: ParsedForm[] = [];
    for (const line of text.normalize('NFKC').split('\n')) {
        const m = line.trim().match(/^(발|찾)\s*\/(.*)$/);
        if (!m) continue;
        const kind: FormKind = m[1] === '발' ? 'dig' : 'find';
        const parts = m[2].split('/').map((x) => x.trim());
        const values: ResultValues = {};
        const notes: string[] = [];
        const put = (k: FieldKey, v?: string) => {
            if (v) values[k] = v;
        };
        if (kind === 'dig') {
            FORMS.dig.fields.slice(0, 8).forEach((k, i) => put(k, parts[i]));
            // 2차 만남: '+일시,장소' 또는 '일시/장소'
            const tail = parts.slice(8);
            if (tail.length) tail[0] = tail[0].replace(/^\+\s*/, '');
            if (tail.length >= 2) {
                put('meet_at', tail[0]);
                put('meet_place', tail.slice(1).join('/').trim());
            } else if (tail.length === 1) {
                const i = tail[0].indexOf(',');
                put('meet_at', (i < 0 ? tail[0] : tail[0].slice(0, i)).trim());
                if (i >= 0) put('meet_place', tail[0].slice(i + 1).trim());
            }
        } else {
            FORMS.find.fields.forEach((k, i) => put(k, parts[i]));
            if (parts.length > FORMS.find.fields.length) {
                delete values.target_month; // 칸이 남으면 어디가 밀렸는지 모르므로 마지막 칸은 다시 질문
                notes.push(`칸이 ${parts.length}개로 양식(${FORMS.find.fields.length}개)보다 많아 목표월을 다시 확인합니다.`);
            }
        }
        out.push({ kind, values, notes });
    }
    return out;
}

export function normalizePhone(raw: string): string | null {
    const d = raw.normalize('NFKC').replace(/[\s\-.()]/g, '');
    if (!/^\d+$/.test(d)) return null;
    if (/^\d{4}$/.test(d)) return d; // 뒷자리 4자리만 받는 운영 방식
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
        return p ? { ok: true, value: p } : { ok: false, reason: `연락처 형식을 확인해주세요: "${v}" (예: 뒷자리 5678 또는 010-1234-5678)` };
    }
    if (key === 'age_group') {
        const hit = AGE_GROUPS.find((a) => squash(a) === squash(v));
        return hit ? { ok: true, value: hit } : { ok: false, reason: `생년 구분은 ${AGE_GROUPS.join(' / ')} 중에서 선택해주세요. (입력: "${v}")` };
    }
    if (key === 'birth_date' && !/\d/.test(v)) return { ok: false, reason: `생년월일을 숫자로 입력해주세요: "${v}" (예: 990315)` };
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

export const missingCount = (r: Record<string, any>) => FORMS[formOf(r.kind)].fields.filter((k) => !r[k]).length;

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
