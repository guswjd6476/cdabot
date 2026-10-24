import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

export { dayjs };

export const TZ = 'Asia/Seoul';

export function nowKst() {
    return dayjs().tz(TZ);
}

export function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function escapeHtml(text?: string | number | null): string {
    if (text === undefined || text === null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ====================== 📅 날짜 ====================== */

// 입력 문자열에서 날짜를 찾아 'YYYY-MM-DD'로 변환 (실패 시 null)
// 지원: 10.8(월), 10/8, 10-08, 10월 8일, 2026.10.8, 26.10.8, 오늘/내일/모레
export function parseFlexibleDate(rawText: string): string | null {
    if (!rawText) return null;
    // 전각 숫자·기호(１０．８ 등) → 반각
    const text = rawText.normalize('NFKC');
    const today = nowKst().startOf('day');

    const toYmd = (year: number, month: number, day: number): string | null => {
        const str = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        return dayjs(str, 'YYYY-MM-DD', true).isValid() ? str : null; // 2/30 같은 없는 날짜는 거부
    };

    // 연도 포함: 2026.10.8 / 2026년 10월 8일 / 26.10.8 (두 자리 연도는 13 이상일 때만 연도로 인정 → 10.8 14시 오인 방지)
    const withYear = text.match(/(?:^|[^\d])(\d{4}|\d{2})\s*[\-\/\.년]\s*(\d{1,2})\s*[\-\/\.월]\s*(\d{1,2})(?!\d)/);
    if (withYear && (withYear[1].length === 4 || parseInt(withYear[1], 10) > 12)) {
        const year = withYear[1].length === 4 ? parseInt(withYear[1], 10) : 2000 + parseInt(withYear[1], 10);
        const ymd = toYmd(year, parseInt(withYear[2], 10), parseInt(withYear[3], 10));
        if (ymd) return ymd;
    }

    // 월·일만: 10.8 / 10/8 / 10-08 / 10월 8일 (뒤의 시간·요일은 무시)
    const monthDay = text.match(/(?:^|[^\d])(\d{1,2})\s*[\-\/\.월]\s*(\d{1,2})(?!\d)/);
    if (monthDay) {
        const month = parseInt(monthDay[1], 10);
        const day = parseInt(monthDay[2], 10);
        // 연도 생략 시 오늘 기준 ±6개월 안에 들어오는 해로 결정 (12월에 1월 입력 → 내년, 1월에 12월 입력 → 작년)
        for (const year of [today.year(), today.year() + 1, today.year() - 1]) {
            const ymd = toYmd(year, month, day);
            if (!ymd) continue;
            const diff = dayjs(ymd).diff(dayjs(today.format('YYYY-MM-DD')), 'day');
            if (diff >= -183 && diff <= 183) return ymd;
        }
        return toYmd(today.year(), month, day);
    }

    const relative = text.match(/오늘|내일|모레/);
    if (relative) {
        const offset = { 오늘: 0, 내일: 1, 모레: 2 }[relative[0] as '오늘' | '내일' | '모레'];
        return today.add(offset, 'day').format('YYYY-MM-DD');
    }

    return null;
}

/* ====================== 💬 텔레그램 메시지 ====================== */

// 텔레그램 메시지 길이 제한(4096자) 대응: 줄 단위로 나눠 여러 메시지로 전송 (HTML 태그는 줄 안에서 닫혀 있어야 함)
export const TELEGRAM_SAFE_LENGTH = 3800;

export function splitLongMessage(text: string, limit = TELEGRAM_SAFE_LENGTH): string[] {
    const parts: string[] = [];
    let current = '';
    for (const line of text.split('\n')) {
        if (current && current.length + line.length + 1 > limit) {
            parts.push(current);
            current = '';
        }
        current += (current ? '\n' : '') + line;
    }
    if (current.trim()) parts.push(current);
    return parts;
}

export async function replyLong(ctx: any, html: string, lastMessageExtra: Record<string, unknown> = {}) {
    const parts = splitLongMessage(html);
    for (let i = 0; i < parts.length; i++) {
        await ctx.reply(parts[i], { parse_mode: 'HTML', ...(i === parts.length - 1 ? lastMessageExtra : {}) });
    }
}
