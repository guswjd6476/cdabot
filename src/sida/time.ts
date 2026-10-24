// 활동 가능 시간 계산 (순수 함수 — DB/텔레그램 없음)
// 시간은 0시 기준 '분' 정수 (09:30 = 570, 24:00 = 1440)

export type Slot = [number, number];
export interface DayInput {
    unavailable: boolean;
    slots: Slot[];
}
export type DayStatus = 'missing' | 'unavailable' | 'ok' | 'short';

export const WEEKDAYS = [1, 2, 3, 4, 5] as const; // 월~금
export const DAY_NAMES = ['', '월', '화', '수', '목', '금', '토', '일'];
export const DEFAULT_MIN_MINUTES = 360; // 하루 최소 6시간

export const fmtClock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const fmtSlot = ([s, e]: Slot) => `${fmtClock(s)}~${fmtClock(e)}`;
export function fmtHours(m: number): string {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}시간 ${r}분` : `${h}시간`;
}

// '09:00~12:00', '9-12', '09:30–13:00' 한 구간 파싱. 자정을 넘는 구간(22:00~02:00)은 정책상 미지원
export function parseRange(raw: string): { slot: Slot } | { error: string } {
    const m = raw
        .normalize('NFKC')
        .trim()
        .match(/^(\d{1,2})(?::(\d{2}))?\s*[~\-–—〜]\s*(\d{1,2})(?::(\d{2}))?$/);
    if (!m) return { error: `형식을 알 수 없습니다: "${raw.trim()}" (예: 09:00~12:00)` };
    const toMin = (h: string, mm?: string) => {
        const hour = Number(h);
        const min = Number(mm || 0);
        if (hour > 24 || min > 59 || (hour === 24 && min > 0)) return null;
        return hour * 60 + min;
    };
    const start = toMin(m[1], m[2]);
    const end = toMin(m[3], m[4]);
    if (start === null || end === null) return { error: `없는 시각입니다: "${raw.trim()}" (00:00~24:00)` };
    if (start === end) return { error: `시작과 종료 시간이 같습니다: "${raw.trim()}"` };
    if (end < start)
        return {
            error: `종료 시간이 시작보다 빠릅니다: "${raw.trim()}"\n자정을 넘는 구간은 지원하지 않으니 22:00~24:00 처럼 24:00까지만 입력해주세요.`,
        };
    return { slot: [start, end] };
}

// 여러 구간 (쉼표·줄바꿈 구분). 하나라도 틀리면 errors 에 담김
export function parseRanges(raw: string): { slots: Slot[]; errors: string[] } {
    const slots: Slot[] = [];
    const errors: string[] = [];
    for (const part of raw.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)) {
        const r = parseRange(part);
        if ('slot' in r) slots.push(r.slot);
        else errors.push(r.error);
    }
    return { slots, errors };
}

// 겹치거나 맞닿은 구간을 합침
export function mergeSlots(slots: Slot[]): Slot[] {
    const sorted = [...slots].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out: Slot[] = [];
    for (const [s, e] of sorted) {
        const last = out[out.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], e);
        else out.push([s, e]);
    }
    return out;
}

// 중복 제거 후 실제 총 분
export const totalMinutes = (slots: Slot[]) => mergeSlots(slots).reduce((sum, [s, e]) => sum + (e - s), 0);

export function dayStatus(day: DayInput | undefined, minMinutes = DEFAULT_MIN_MINUTES): DayStatus {
    if (!day) return 'missing';
    if (day.unavailable) return 'unavailable';
    return totalMinutes(day.slots) >= minMinutes ? 'ok' : 'short';
}

export const STATUS_LABEL: Record<DayStatus, string> = {
    missing: '⏳ 미제출',
    unavailable: '🚫 활동 불가',
    ok: '✅ 충족',
    short: '⚠️ 미충족',
};

export interface Segment {
    start: number;
    end: number;
    names: string[];
}

// 실제 제출된 구간의 시작·종료 시점으로 하루를 나누고, 각 구간에 가능한 대원 표시 (고정 시간대 없음)
export function buildTimetable(entries: { name: string; slots: Slot[] }[]): Segment[] {
    const merged = entries.map((e) => ({ name: e.name, slots: mergeSlots(e.slots) }));
    const points = [...new Set(merged.flatMap((e) => e.slots.flat()))].sort((a, b) => a - b);
    const segs: Segment[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        const [a, b] = [points[i], points[i + 1]];
        const names = merged.filter((e) => e.slots.some(([s, en]) => s <= a && b <= en)).map((e) => e.name);
        if (!names.length) continue;
        const last = segs[segs.length - 1];
        // 바로 이어지고 대원 구성이 같으면 한 줄로
        if (last && last.end === a && last.names.join('\n') === names.join('\n')) last.end = b;
        else segs.push({ start: a, end: b, names });
    }
    return segs;
}
